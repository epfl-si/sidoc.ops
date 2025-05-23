const axios = require('axios');
const https = require('https');
const fs = require('fs');
require('dotenv').config();

/**
 * OutlineSync - Synchronization utility for Outline Wiki
 *
 * Handles:
 * - User to group synchronization based on EPFL units
 * - Admin user synchronization
 * - Collections synchronization and cleanup
 * - Group management with allowlist support
 */

const agent = new https.Agent({ rejectUnauthorized: false });

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
	debug: (message, data) => {
		if (process.env.DEBUG === 'true') {
			logger.log('DEBUG', message, data);
		}
	},
};

class OutlineSync {
	/**
	 * Initialize OutlineSync with required configuration
	 * @param {String} baseUrl - Outline API base URL
	 * @param {String} apiToken - Outline API token
	 */
	constructor(baseUrl, apiToken) {
		if (!baseUrl || !apiToken) {
			throw new Error('Missing required configuration: baseUrl or apiToken');
		}

		this.outlineClient = axios.create({
			baseURL: baseUrl,
			headers: {
				Authorization: `Bearer ${apiToken}`,
				'Content-Type': 'application/json',
			},
			httpsAgent: agent,
			timeout: 10000,
		});

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

		this._addInterceptors(this.outlineClient, 'Outline');
		this._addInterceptors(this.epflClient, 'EPFL');

		this.ADMIN_EMAIL = process.env.OUTLINE_ADMIN_EMAIL || 'admin@epfl.ch';
		this.ADMIN_GROUP_NAME = 'admin';
		this.ALLOWED_COLLECTIONS = process.env.ALLOWED_COLLECTIONS ? process.env.ALLOWED_COLLECTIONS.split(',') : ['welcome'];
	}

	/**
	 * Add request and response interceptors to the API client
	 * @param {Object} client - Axios client instance
	 * @param {String} clientName - Name of the client for logging
	 * @private
	 */
	_addInterceptors(client, clientName) {
		client.interceptors.request.use(
			(config) => {
				logger.debug(`${clientName} API Request`, {
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
		try {
			const personResponse = await this.epflClient.get(`/persons/${email}`);
			const sciper = personResponse?.data.id;

			if (!sciper) {
				logger.warn(`No SCIPER found for email: ${email}`);
				return [];
			}

			const unitsResponse = await this.epflClient.get(`/units?persid=${sciper}`);

			logger.info('Units retrieved successfully', {
				email,
				sciper,
				totalUnits: unitsResponse.data.count,
			});

			return unitsResponse.data.units || [];
		} catch (error) {
			logger.error('Error retrieving user units', {
				email,
				error: error.message,
			});
			return [];
		}
	}

	/**
	 * Get all active users from Outline
	 * @returns {Array} - List of active users
	 */
	async getAllUsers() {
		const response = await this.outlineClient.post('/api/users.list', { limit: 100 });
		const activeUsers = response.data.data.filter((user) => user.email !== this.ADMIN_EMAIL);

		logger.info('Retrieved active users', { count: activeUsers.length });
		return activeUsers;
	}

	/**
	 * Get all groups from Outline
	 * @returns {Array} - List of groups
	 */
	async getAllGroups() {
		const response = await this.outlineClient.post('/api/groups.list', { limit: 100 });
		const groups = response.data.data.groups;

		logger.info('Retrieved groups', { count: groups.length });
		return groups;
	}

	/**
	 * Get all admin users from EPFL API
	 * @returns {Array} - List of admin users
	 */
	async getAllAdmins() {
		try {
			const fetchAdminsRecursively = async (group, visitedGroups = new Set()) => {
				if (visitedGroups.has(group)) {
					return [];
				}
				visitedGroups.add(group);

				const response = await this.epflClient.get(`/groups/${group}/members`);
				const members = response.data.members || [];

				let admins = [];
				for (const member of members) {
					if (member.type === 'person') {
						admins.push({ id: member.id, email: member.email });
					} else if (member.type === 'group') {
						const subGroupAdmins = await fetchAdminsRecursively(member.id, visitedGroups);
						admins = admins.concat(subGroupAdmins);
					}
				}

				return admins;
			};

			const adminGroupName = process.env.OUTLINE_ADMIN_GROUP || 'wiki-admins';
			const allAdmins = await fetchAdminsRecursively(adminGroupName, new Set());

			const uniqueAdmins = Array.from(new Map(allAdmins.map((admin) => [admin.id, admin])).values());

			logger.info('Retrieved admin users', {
				count: uniqueAdmins.length,
				adminGroup: adminGroupName,
			});

			return uniqueAdmins;
		} catch (error) {
			logger.error('Error retrieving admin users', { error: error.message });
			return [];
		}
	}

	/**
	 * Get all allowed units from configuration file
	 * @returns {Array} - List of allowed units
	 */
	async getAllowedUnits() {
		try {
			const allowedUnitsFile = process.env.EPFL_ALLOWED_UNITS_FILE;

			if (!allowedUnitsFile) {
				logger.info('No allowed units file specified, all units are allowed');
				return null;
			}

			if (!fs.existsSync(allowedUnitsFile)) {
				logger.warn('Allowed units file does not exist', { file: allowedUnitsFile });
				return [];
			}

			const fileContent = fs.readFileSync(allowedUnitsFile, 'utf8');
			const allowedUnits = JSON.parse(fileContent);

			if (!Array.isArray(allowedUnits)) {
				throw new Error('Invalid format: Expected an array of units in the file');
			}

			logger.info('Retrieved allowed units', { count: allowedUnits.length });
			return allowedUnits;
		} catch (err) {
			logger.error('Error reading allowed units file', { error: err.message });
			return [];
		}
	}

	/**
	 * Check if a unit is in the allowed list
	 * @param {Object} unit - Unit object
	 * @param {Array|null} allowedUnits - List of allowed units or null if all allowed
	 * @returns {Boolean} - Whether the unit is allowed
	 */
	isUnitAllowed(unit, allowedUnits) {
		if (allowedUnits === null) {
			return true;
		}

		return allowedUnits.some((allowedUnit) => allowedUnit.toLowerCase() === unit.name.toLowerCase());
	}

	/**
	 * Get all collections from Outline
	 * @returns {Array} - List of collections
	 */
	async getAllCollections() {
		const response = await this.outlineClient.post('/api/collections.list', { limit: 100 });
		const collections = response.data.data;

		logger.info('Retrieved collections', { count: collections.length });
		return collections;
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
	async findGroupByName(name) {
		const groups = await this.getAllGroups();

		let group = groups.find((g) => g.name === name);
		if (group) return group;

		return groups.find((g) => g.name.toLowerCase() === name.toLowerCase()) || null;
	}

	/**
	 * Find a collection by name (case-insensitive)
	 * @param {String} name - Collection name
	 * @returns {Object|null} - Collection object or null if not found
	 */
	async findCollectionByName(name) {
		const collections = await this.getAllCollections();

		let collection = collections.find((c) => c.name === name);
		if (collection) return collection;

		return collections.find((c) => c.name.toLowerCase() === name.toLowerCase()) || null;
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
	 * Update a group's name
	 * @param {String} groupId - Group ID
	 * @param {String} newName - New group name
	 * @returns {Object} - Updated group
	 */
	async updateGroupName(groupId, newName) {
		logger.info('Updating group name', { groupId, newName });
		const response = await this.outlineClient.post('/api/groups.update', {
			id: groupId,
			name: newName,
		});
		logger.info('Group name updated successfully', {
			groupId,
			newName,
		});
		return response.data.data;
	}

	/**
	 * Create a new collection
	 * @param {String} name - Collection name
	 * @param {Boolean} isPrivate - Whether the collection is private
	 * @returns {Object} - Created collection
	 */
	async createCollection(name, isPrivate = false) {
		const response = await this.outlineClient.post('/api/collections.create', {
			name,
			permission: 'read',
			private: isPrivate,
		});

		const collectionId = response.data.data.id;
		logger.info('Collection created', { collectionId, collectionName: name });
		return response.data.data;
	}

	/**
	 * Update a collection's name and privacy
	 * @param {String} collectionId - Collection ID
	 * @param {String} newName - New collection name
	 * @param {Boolean} isPrivate - Whether the collection is private
	 * @returns {Object} - Updated collection
	 */
	async updateCollection(collectionId, newName, isPrivate = true) {
		logger.info('Updating collection', { collectionId, newName, isPrivate });
		const response = await this.outlineClient.post('/api/collections.update', {
			id: collectionId,
			name: newName,
			private: isPrivate,
		});
		logger.info('Collection updated successfully', {
			collectionId,
			newName,
			isPrivate,
		});
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
			if (error.response && error.response.status === 400 && error.response.data.message && error.response.data.message.includes('already a member')) {
				logger.info('User is already a member of group', { groupId, userId });
				return true;
			}

			throw error;
		}
	}

	/**
	 * Update a user's role to admin
	 * @param {String} userId - User ID
	 * @param {String} email - User email for logging
	 * @returns {Boolean} - Success status
	 */
	async makeUserAdmin(userId, email) {
		logger.info('Checking user role before making user an admin', { userId, email });
		const response = await this.outlineClient.post('/api/users.info', { id: userId });
		const currentRole = response.data.data.role;

		if (currentRole === 'admin') {
			logger.info('User is already an admin', { userId, email });
			return true;
		}

		logger.info('Making user an admin', { userId, email });
		await this.outlineClient.post('/api/users.update_role', { id: userId, role: 'admin' });
		logger.info('User made admin successfully', { userId, email });
		return true;
	}

	/**
	 * Remove admin role from user
	 * @param {String} userId - User ID
	 * @param {String} email - User email for logging
	 * @returns {Boolean} - Success status
	 */
	async removeUserAdmin(userId, email) {
		logger.info('Checking user role before removing admin role', { userId, email });
		const response = await this.outlineClient.post('/api/users.info', { id: userId });
		const currentRole = response.data.data.role;

		if (currentRole !== 'admin') {
			logger.info('User is not an admin, no action needed', { userId, email });
			return true;
		}

		logger.info('Removing admin role from user', { userId, email });
		await this.outlineClient.post('/api/users.update_role', { id: userId, role: 'viewer' });
		logger.info('Admin role removed from user', { userId, email });
		return true;
	}

	/**
	 * Add group to a collection
	 * @param {String} groupId - Group ID
	 * @param {String} collectionId - Collection ID
	 * @param {String} permission - Permission level (read, read_write, etc.)
	 * @returns {Boolean} - Success status
	 */
	async addGroupToCollection(groupId, collectionId, permission = 'read_write') {
		logger.info('Adding group to collection', { groupId, collectionId, permission });
		await this.outlineClient.post('/api/collections.add_group', {
			id: collectionId,
			groupId,
			permission,
		});
		logger.info('Group added to collection successfully', { groupId, collectionId });
		return true;
	}

	/**
	 * Make collection private
	 * @param {String} collectionId - Collection ID
	 * @returns {Boolean} - Success status
	 */
	async makeCollectionPrivate(collectionId) {
		logger.info('Making collection private', { collectionId });
		await this.outlineClient.post('/api/collections.update', {
			id: collectionId,
			permission: null,
		});
		logger.info('Collection made private successfully', { collectionId });
		return true;
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
	 * Get all admin users
	 * @returns {Array} - List of admin users
	 */
	async getAllAdminUsers() {
		const response = await this.outlineClient.post('/api/users.list', {
			role: 'admin',
		});
		return response.data.data.filter((user) => user.email !== this.ADMIN_EMAIL);
	}

	/**
	 * Delete a group
	 * @param {String} groupId - Group ID
	 * @returns {Boolean} - Success status
	 */
	async deleteGroup(groupId) {
		logger.info('Deleting group', { groupId });
		await this.outlineClient.post('/api/groups.delete', { id: groupId });
		logger.info('Group deleted successfully', { groupId });
		return true;
	}

	/**
	 * Delete a collection
	 * @param {String} collectionId - Collection ID
	 * @returns {Boolean} - Success status
	 */
	async deleteCollection(collectionId) {
		logger.info('Deleting collection', { collectionId });
		await this.outlineClient.post('/api/collections.delete', { id: collectionId });
		logger.info('Collection deleted successfully', { collectionId });
		return true;
	}

	/**
	 * Check if a collection is managed (part of synchronized collections)
	 * @param {Object} collection - Collection object
	 * @param {Array} groupNames - List of valid group names
	 * @returns {Boolean} - Whether the collection is managed
	 */
	isCollectionManaged(collection, groupNames) {
		if (collection.name.toLowerCase() === this.ADMIN_GROUP_NAME.toLowerCase()) {
			return true;
		}

		return groupNames.includes(collection.name.toLowerCase());
	}

	/**
	 * Synchronize users with their corresponding units/groups
	 * @returns {Object} - Sync results including success status
	 */
	async syncUsers() {
		try {
			const activeUsers = await this.getAllUsers();
			const existingGroups = await this.getAllGroups();
			const allowedUnits = await this.getAllowedUnits();

			if (!activeUsers.length) {
				logger.warn('No active users found, sync cannot proceed');
				return {
					success: false,
					reason: 'No active users found',
				};
			}

			logger.info('Starting user synchronization', {
				activeUsersCount: activeUsers.length,
				existingGroupsCount: existingGroups.length,
				allowedUnitsMode: allowedUnits === null ? 'all allowed' : `${allowedUnits.length} units allowed`,
			});

			const userUnitsMap = {};
			let totalUnitsFound = 0;

			for (const user of activeUsers) {
				const units = await this.getUserUnits(user.email);

				const filteredUnits = allowedUnits === null ? units : units.filter((unit) => this.isUnitAllowed(unit, allowedUnits));

				userUnitsMap[user.email] = filteredUnits;
				totalUnitsFound += filteredUnits.length;

				logger.info('Retrieved units for user', {
					email: user.email,
					totalUnits: units.length,
					allowedUnits: filteredUnits.length,
				});
			}

			logger.info('Unit data retrieval completed', {
				totalUsers: activeUsers.length,
				totalAllowedUnitsFound: totalUnitsFound,
			});

			const validGroupNames = new Set();
			validGroupNames.add(this.ADMIN_GROUP_NAME.toLowerCase());

			for (const user of activeUsers) {
				const unitsForUser = userUnitsMap[user.email] || [];
				logger.info('Processing user units', {
					email: user.email,
					unitCount: unitsForUser.length,
				});

				for (const unit of unitsForUser) {
					let group = await this.findGroupByName(unit.name);

					if (!group) {
						group = await this.createGroup(unit.name);
					}

					await this.addUserToGroup(user.id, group.id);

					validGroupNames.add(unit.name.toLowerCase());
				}
			}

			const adminGroup = await this.ensureAdminGroup();
			const admins = await this.getAllAdmins();

			for (const admin of admins) {
				const user = await this.findUserByEmail(admin.email);
				if (user) {
					await this.addUserToGroup(user.id, adminGroup.id);

					await this.makeUserAdmin(user.id, admin.email);
				}
			}

			for (const group of existingGroups) {
				const groupNameLower = group.name.toLowerCase();

				if (groupNameLower === this.ADMIN_GROUP_NAME.toLowerCase()) {
					continue;
				}

				if (!validGroupNames.has(groupNameLower)) {
					await this.deleteGroup(group.id);
					logger.info('Group deleted as it is no longer needed', { groupName: group.name });
				}
			}

			for (const group of existingGroups) {
				const groupName = group.name;

				const groupMembers = await this.getGroupMembers(group.id);

				if (groupName.toLowerCase() === this.ADMIN_GROUP_NAME.toLowerCase()) {
					for (const member of groupMembers) {
						const isAdmin = admins.some((admin) => admin.email === member.email);
						if (!isAdmin) {
							await this.removeUserFromGroup(member.id, group.id);

							await this.removeUserAdmin(member.id, member.email);
						}
					}
				} else {
					for (const member of groupMembers) {
						const user = activeUsers.find((u) => u.id === member.id);
						if (!user) continue;

						const memberUnits = userUnitsMap[user.email] || [];
						const shouldBeInGroup = memberUnits.some((unit) => unit.name.toLowerCase() === groupName.toLowerCase());

						if (!shouldBeInGroup) {
							logger.info('Removing user from group they no longer belong to', {
								email: user.email,
								groupName: group.name,
							});
							await this.removeUserFromGroup(member.id, group.id);
						}
					}
				}
			}

			logger.info('User synchronization completed successfully');
			return { success: true };
		} catch (error) {
			logger.error('Error during user synchronization', {
				errorMessage: error.message,
				stack: error.stack,
			});

			return {
				success: false,
				error: error.message,
			};
		}
	}

	/**
	 * Create or get the admin group
	 * @returns {Object} - Admin group
	 */
	async ensureAdminGroup() {
		let adminGroup = await this.findGroupByName(this.ADMIN_GROUP_NAME);

		if (!adminGroup) {
			adminGroup = await this.createGroup(this.ADMIN_GROUP_NAME);
		}

		return adminGroup;
	}

	/**
	 * Synchronize admin users
	 * @returns {Object} - Sync results including success status
	 */
	async syncAdmins() {
		try {
			const epflAdmins = await this.getAllAdmins();
			const existingAdminUsers = await this.getAllAdminUsers();

			const adminGroup = await this.ensureAdminGroup();

			logger.info('Starting admin synchronization', {
				adminsCount: epflAdmins.length,
				existingAdminUsersCount: existingAdminUsers.length,
			});

			for (const admin of epflAdmins) {
				const user = await this.findUserByEmail(admin.email);
				if (user) {
					const isAdminAlready = existingAdminUsers.some((existingAdmin) => existingAdmin.id === user.id);

					await this.addUserToGroup(user.id, adminGroup.id);

					if (!isAdminAlready) {
						await this.makeUserAdmin(user.id, admin.email);
					}
				} else {
					logger.warn('User not found for admin', { email: admin.email });
				}
			}

			for (const existingAdmin of existingAdminUsers) {
				const isStillAdmin = epflAdmins.some((admin) => admin.email === existingAdmin.email);

				if (!isStillAdmin) {
					await this.removeUserAdmin(existingAdmin.id, existingAdmin.email);

					await this.removeUserFromGroup(existingAdmin.id, adminGroup.id);
				}
			}

			logger.info('Admin synchronization completed successfully');
			return { success: true };
		} catch (error) {
			logger.error('Error during admin synchronization', {
				errorMessage: error.message,
				stack: error.stack,
			});

			return {
				success: false,
				error: error.message,
			};
		}
	}

	/**
	 * Synchronize collections based on groups
	 * @returns {Object} - Sync results including success status
	 */
	async syncCollections() {
		try {
			const groups = await this.getAllGroups();
			const collections = await this.getAllCollections();
			const adminGroup = await this.ensureAdminGroup();

			const groupNames = groups.filter((g) => g.name.toLowerCase() !== this.ADMIN_GROUP_NAME.toLowerCase()).map((g) => g.name.toLowerCase());

			logger.info('Starting collection synchronization', {
				groupsCount: groups.length,
				collectionsCount: collections.length,
			});

			for (const group of groups) {
				if (group.name.toLowerCase() === this.ADMIN_GROUP_NAME.toLowerCase()) {
					continue;
				}

				let collection = await this.findCollectionByName(group.name);

				if (!collection) {
					collection = await this.createCollection(group.name, false);
				}

				await this.addGroupToCollection(group.id, collection.id, 'read_write');
			}

			for (const collection of collections) {
				const collectionName = collection.name.toLowerCase();

				if (collectionName === this.ADMIN_GROUP_NAME.toLowerCase()) {
					continue;
				}

				if (this.ALLOWED_COLLECTIONS.includes(collectionName)) {
					continue;
				}

				const hasMatchingGroup = groupNames.includes(collectionName);

				if (!hasMatchingGroup) {
					await this.deleteCollection(collection.id);
					logger.info('Collection deleted as it no longer has a corresponding group', {
						collectionName: collection.name,
					});
				}
			}

			logger.info('Collection synchronization completed successfully');
			return { success: true };
		} catch (error) {
			logger.error('Error during collection synchronization', {
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
		const requiredEnvVars = ['OUTLINE_BASE_URL', 'OUTLINE_API_TOKEN', 'EPFL_API_URL', 'EPFL_API_USERNAME', 'EPFL_API_PASSWORD', 'OUTLINE_ADMIN_GROUP'];

		const missingVars = requiredEnvVars.filter((varName) => !process.env[varName]);

		if (missingVars.length > 0) {
			throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
		}

		const outlineSync = new OutlineSync(process.env.OUTLINE_BASE_URL, process.env.OUTLINE_API_TOKEN);

		logger.info('Starting user synchronization process');
		const userResult = await outlineSync.syncUsers();
		if (!userResult.success) {
			exitCode = 1;
			logger.error('User synchronization failed', {
				reason: userResult.reason || userResult.error || 'Unknown error',
			});
		}

		logger.info('Starting admin synchronization process');
		const adminResult = await outlineSync.syncAdmins();
		if (!adminResult.success) {
			exitCode = 1;
			logger.error('Admin synchronization failed', {
				reason: adminResult.reason || adminResult.error || 'Unknown error',
			});
		}

		logger.info('Starting collection synchronization process');
		const collectionResult = await outlineSync.syncCollections();
		if (!collectionResult.success) {
			exitCode = 1;
			logger.error('Collection synchronization failed', {
				reason: collectionResult.reason || collectionResult.error || 'Unknown error',
			});
		}

		logger.info('Complete synchronization process finished', {
			status: exitCode === 0 ? 'success' : 'partial failure',
		});
	} catch (error) {
		exitCode = 1;
		logger.error('Synchronization failed with unexpected error', {
			errorMessage: error.message,
			stack: error.stack,
		});
	} finally {
		logger.info(`Process exiting with code: ${exitCode}`, {
			timestamp: new Date().toISOString(),
		});
		process.exit(exitCode);
	}
}

main();
