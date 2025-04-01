const axios = require('axios');
const https = require('https');
require('dotenv').config();

// Create secure HTTPS agent
const agent = new https.Agent({ rejectUnauthorized: false });

// Logger implementation with structured output
const logger = {
	log: (level, message, data = {}) => {
		console.log(
			JSON.stringify({
				timestamp: new Date().toISOString(),
				level,
				message,
				...data,
			})
		);
	},
	info: (message, data) => logger.log('INFO', message, data),
	error: (message, data) => logger.log('ERROR', message, data),
	warn: (message, data) => logger.log('WARN', message, data),
};

class OutlineSync {
	constructor(baseUrl, apiToken) {
		if (!baseUrl || !apiToken) {
			throw new Error('Missing required configuration: baseUrl or apiToken');
		}

		// Initialize Outline API client
		this.outlineClient = axios.create({
			baseURL: baseUrl,
			headers: {
				Authorization: `Bearer ${apiToken}`,
				'Content-Type': 'application/json',
			},
			httpsAgent: agent,
			timeout: 10000,
		});

		// Initialize EPFL API client
		const epflApiUrl = process.env.EPFL_API_URL;
		const epflUsername = process.env.EPFL_API_USERNAME;
		const epflPassword = process.env.EPFL_API_PASSWORD;

		if (!epflApiUrl || !epflUsername || !epflPassword) {
			throw new Error('Missing required EPFL API configuration');
		}

		this.epflClient = axios.create({
			baseURL: epflApiUrl,
			headers: {
				Authorization: `Basic ${Buffer.from(`${epflUsername}:${epflPassword}`).toString('base64')}`,
			},
			timeout: 10000,
		});

		// Add interceptors to both clients
		this._addInterceptors(this.outlineClient, 'Outline');
		this._addInterceptors(this.epflClient, 'EPFL');
	}

	/**
	 * Add request and response interceptors to the API client
	 * @param {Object} client - Axios client instance
	 * @param {String} clientName - Name of the client for logging
	 * @private
	 */
	_addInterceptors(client, clientName) {
		// Request interceptor
		client.interceptors.request.use(
			(config) => {
				logger.info(`${clientName} API Request`, {
					method: config.method,
					url: config.url,
				});
				return config;
			},
			(error) => {
				logger.error(`${clientName} API Request Error`, {
					message: error.message,
					stack: error.stack,
				});
				return Promise.reject(error);
			}
		);

		// Response interceptor
		client.interceptors.response.use(
			(response) => response,
			(error) => {
				if (error.response) {
					logger.error(`${clientName} API Response Error`, {
						status: error.response.status,
						data: error.response.data,
						headers: error.response.headers,
					});
				} else if (error.request) {
					logger.error(`${clientName} No Response Received`, {
						request: error.request,
					});
				} else {
					logger.error(`${clientName} Request Setup Error`, {
						message: error.message,
					});
				}
				return Promise.reject(error);
			}
		);
	}

	/**
	 * Get units for a user by email
	 * @param {String} email - User email
	 * @returns {Array} - List of units
	 */
	async getUserUnits(email) {
		// Get SCIPER from email
		const personResponse = await this.epflClient.get(`/persons/${email}`);
		const sciper = personResponse?.data.id;

		if (!sciper) {
			logger.warn(`No SCIPER found for email: ${email}`);
			return [];
		}

		// Get units for the SCIPER
		const unitsResponse = await this.epflClient.get(`/units?persid=${sciper}`);

		logger.info('Units retrieved successfully', {
			email,
			sciper,
			totalUnits: unitsResponse.data.count,
		});

		return unitsResponse.data.units;
	}

	/**
	 * Get all active users from Outline
	 * @returns {Array} - List of active users
	 */
	async getAllUsers() {
		const response = await this.outlineClient.post('/api/users.list');
		const activeUsers = response.data.data.filter((user) => user.lastActiveAt);

		logger.info('Retrieved active users', { count: activeUsers.length });
		return activeUsers;
	}

	/**
	 * Get all groups from Outline
	 * @returns {Array} - List of groups
	 */
	async getAllGroups() {
		const response = await this.outlineClient.post('/api/groups.list');
		const groups = response.data.data.groups;

		logger.info('Retrieved groups', { count: groups.length });
		return groups;
	}

	/**
	 * Find a user by email
	 * @param {String} email - User email
	 * @returns {Object|null} - User object or null if not found
	 */
	async findUserByEmail(email) {
		const users = await this.getAllUsers();
		return users.find((u) => u.email === email) || null;
	}

	/**
	 * Find a group by name (case-insensitive)
	 * @param {String} name - Group name
	 * @returns {Object|null} - Group object or null if not found
	 */
	async findExistingGroup(name) {
		const groups = await this.getAllGroups();
		return groups.find((g) => g.name.toLowerCase() === name.toLowerCase()) || null;
	}

	/**
	 * Find a collection by name (case-insensitive)
	 * @param {String} name - Collection name
	 * @returns {Object|null} - Collection object or null if not found
	 */
	async findExistingCollection(name) {
		const response = await this.outlineClient.post('/api/collections.list', { limit: 100 });
		return response.data.data.find((collection) => collection.name.toLowerCase() === name.toLowerCase()) || null;
	}

	/**
	 * Create a new group
	 * @param {String} name - Group name
	 * @returns {Object} - Created group
	 */
	async createGroup(name) {
		logger.info('Creating group', { groupName: name });
		const response = await this.outlineClient.post('/api/groups.create', { name });
		logger.info('Group created successfully', {
			groupId: response.data.data.id,
			groupName: name,
		});
		return response.data.data;
	}

	/**
	 * Create a new collection and assign it to a group
	 * @param {String} name - Collection name
	 * @param {String} groupId - Group ID
	 * @returns {Object} - Created collection
	 */
	async createCollection(name, groupId) {
		// Create the collection
		const response = await this.outlineClient.post('/api/collections.create', {
			name,
			permission: 'read',
			private: true,
		});

		const collectionId = response.data.data.id;
		logger.info('Collection created', { collectionId, collectionName: name });

		// Assign the collection to the group
		await this.outlineClient.post('/api/collections.add_group', {
			id: collectionId,
			groupId,
			permission: 'read_write',
		});

		logger.info('Collection assigned to group', { collectionId, groupId });
		return response.data.data;
	}

	/**
	 * Add a user to a group
	 * @param {String} userId - User ID
	 * @param {String} groupId - Group ID
	 * @returns {Boolean} - Success status
	 */
	async addUserToGroup(userId, groupId) {
		try {
			await this.outlineClient.post('/api/groups.add_user', { id: groupId, userId });
			logger.info('User added to group', { groupId, userId });
			return true;
		} catch (error) {
			// Only catch the "already a member" error
			if (error.response && error.response.status === 400 && error.response.data.message && error.response.data.message.includes('already a member')) {
				logger.info('User is already a member of group', { groupId, userId });
				return true;
			}
			// Re-throw all other errors
			throw error;
		}
	}

	/**
	 * Remove a user from a group
	 * @param {String} userId - User ID
	 * @param {String} groupId - Group ID
	 * @returns {Boolean} - Success status
	 */
	async removeUserFromGroup(userId, groupId) {
		await this.outlineClient.post('/api/groups.remove_user', { id: groupId, userId });
		logger.info('User removed from group', { groupId, userId });
		return true;
	}

	/**
	 * Get members of a group
	 * @param {String} groupId - Group ID
	 * @returns {Array} - List of users in the group
	 */
	async getGroupMembers(groupId) {
		const response = await this.outlineClient.post('/api/groups.memberships', {
			id: groupId,
			limit: 100,
		});
		return response.data.data.users;
	}

	/**
	 * Synchronize users with their corresponding units/groups
	 * @returns {Object} - Sync results including success status
	 */
	async syncUsers() {
		try {
			// Get all active users and existing groups
			const activeUsers = await this.getAllUsers();
			const existingGroups = await this.getAllGroups();

			if (!activeUsers.length) {
				logger.warn('No active users found, sync cannot proceed');
				return {
					success: false,
					reason: 'No active users found',
				};
			}

			logger.info('Starting synchronization', {
				activeUsersCount: activeUsers.length,
				existingGroupsCount: existingGroups.length,
			});

			// Fetch units for all users
			const userUnitsMap = {};
			let totalUnitsFound = 0;

			for (const user of activeUsers) {
				const units = await this.getUserUnits(user.email);
				userUnitsMap[user.email] = units;
				totalUnitsFound += units.length;

				logger.info('Retrieved units for user', {
					email: user.email,
					unitsCount: units.length,
				});
			}

			logger.info('Unit data retrieval completed', {
				totalUsers: activeUsers.length,
				totalUnitsFound,
			});

			// Ensure users are in the correct groups
			let usersProcessed = 0;

			for (const user of activeUsers) {
				const unitsForUser = userUnitsMap[user.email] || [];
				logger.info('Processing user', { email: user.email, unitCount: unitsForUser.length });

				for (const unit of unitsForUser) {
					// Find or create group
					let group = await this.findExistingGroup(unit.name);
					if (!group) {
						logger.info('Group does not exist, creating new group', { unitName: unit.name });
						group = await this.createGroup(unit.name);
					}

					// Add user to group
					await this.addUserToGroup(user.id, group.id);

					// Find or create collection
					let collection = await this.findExistingCollection(unit.name);
					if (!collection) {
						logger.info('Collection does not exist, creating new collection', { unitName: unit.name });
						collection = await this.createCollection(unit.name, group.id);
					}
				}

				usersProcessed++;
				logger.info('User processing progress', {
					processed: usersProcessed,
					total: activeUsers.length,
					percentComplete: Math.round((usersProcessed / activeUsers.length) * 100),
				});
			}

			// Remove users from groups they shouldn't be in
			let groupsProcessed = 0;

			for (const group of existingGroups) {
				// Check if this group corresponds to a unit
				const unit = Object.values(userUnitsMap)
					.flat()
					.find((u) => u.name.toLowerCase() === group.name.toLowerCase());

				if (unit) {
					// Get current members of the group
					const groupMembers = await this.getGroupMembers(group.id);

					// Remove users that don't belong to the unit
					for (const member of groupMembers) {
						const user = activeUsers.find((user) => user.id === member.id);
						if (!user) continue;

						const memberUnits = userUnitsMap[user.email] || [];
						const shouldBeInGroup = memberUnits.some((u) => u.name.toLowerCase() === group.name.toLowerCase());

						if (!shouldBeInGroup) {
							logger.info('Removing user from group they no longer belong to', {
								email: user.email,
								groupName: group.name,
							});
							await this.removeUserFromGroup(member.id, group.id);
						}
					}
				}

				groupsProcessed++;
				logger.info('Group processing progress', {
					processed: groupsProcessed,
					total: existingGroups.length,
					percentComplete: Math.round((groupsProcessed / existingGroups.length) * 100),
				});
			}

			logger.info('Synchronization completed successfully');
			return { success: true };
		} catch (error) {
			logger.error('Error during synchronization', {
				errorMessage: error.message,
				stack: error.stack,
			});

			return {
				success: false,
				error: error.message,
			};
		}
	}
}

/**
 * Main function
 */
async function main() {
	let exitCode = 0;

	try {
		// Validate environment variables
		const requiredEnvVars = ['OUTLINE_BASE_URL', 'OUTLINE_API_TOKEN', 'EPFL_API_URL', 'EPFL_API_USERNAME', 'EPFL_API_PASSWORD'];

		const missingVars = requiredEnvVars.filter((varName) => !process.env[varName]);

		if (missingVars.length > 0) {
			throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
		}

		// Initialize and run sync
		const outlineSync = new OutlineSync(process.env.OUTLINE_BASE_URL, process.env.OUTLINE_API_TOKEN);

		const result = await outlineSync.syncUsers();

		if (!result.success) {
			// Complete failure
			exitCode = 1;
			logger.error('Synchronization failed', {
				reason: result.reason || result.error || 'Unknown error',
			});
		} else {
			// Full success
			logger.info('Synchronization process completed successfully');
		}
	} catch (error) {
		// Unexpected error
		exitCode = 1;
		logger.error('Synchronization failed with unexpected error', {
			errorMessage: error.message,
			stack: error.stack,
		});
	} finally {
		// Log summary before exit
		logger.info(`Process exiting with code: ${exitCode}`, {
			timestamp: new Date().toISOString(),
		});
		process.exit(exitCode);
	}
}

// Run main function
main();
