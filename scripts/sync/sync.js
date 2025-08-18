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

	async _makeOutlineApiCall(method, endpoint, data = {}) {
		try {
			let results = [];
			let offset = 0;
			const limit = 100;
			let total = null;
			let firstResponse = null;

			do {
				const response = await this.outlineClient.post(endpoint, { ...data, limit, offset });
				if (!firstResponse) firstResponse = response;
				const pageData = response.data.data || [];
				results = results.concat(pageData);

				const pagination = response.data.pagination;
				if (pagination) {
					total = pagination.total;
					offset += limit;
				} else {
					break;
				}
			} while (total !== null && results.length < total);

			if (firstResponse) {
				return {
					...firstResponse.data,
					data: results,
				};
			}
			return null;
		} catch (error) {
			logger.error(`Outline API ${method} ${endpoint} failed`, {
				method,
				endpoint,
				data,
				error: error.message,
			});
			throw error;
		}
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
				throw new Error(`No SCIPER found for user ${email} - cannot retrieve units`);
			}

			const unitsResponse = await this.epflClient.get(`/units?persid=${sciper}`);

			logger.debug('Units retrieved for user', {
				email,
				sciper,
				totalUnits: unitsResponse.data.count,
			});

			return unitsResponse.data.units || [];
		} catch (error) {
			logger.error(`Failed to retrieve units for user ${email}`, {
				email,
				error: error.message,
			});
			throw error;
		}
	}

	/**
	 * Get all active users from Outline
	 * @returns {Array} - List of active users
	 */
	async getAllUsers() {
		try {
			const response = await this._makeOutlineApiCall('POST', '/api/users.list', {});
			const activeUsers = response.data.filter((user) => user.email !== this.ADMIN_EMAIL);

			logger.debug('Retrieved active users', { count: activeUsers.length });
			return activeUsers;
		} catch (error) {
			logger.error('Failed to retrieve users from Outline API', { error: error.message });
			throw error;
		}
	}

	/**
	 * Get all groups from Outline
	 * @returns {Array} - List of groups
	 */
	async getAllGroups() {
		try {
			const response = await this._makeOutlineApiCall('POST', '/api/groups.list', {});
			const groups = response.data.map((data) => data.groups || data).flat();

			logger.debug('Retrieved groups', { count: groups.length });
			return groups;
		} catch (error) {
			logger.error('Failed to retrieve groups from Outline API', { error: error.message });
			throw error;
		}
	}

	/**
	 * Get all admin users from EPFL API
	 * @returns {Array} - List of admin users
	 */
	async getAllAdmins() {
		try {
			const adminGroupName = process.env.OUTLINE_ADMIN_GROUP;
			const response = await this.epflClient.get(`/groups/${adminGroupName}/members?recursive=1`);
			const members = response.data.members || [];

			const admins = members.filter((member) => member.type === 'person').map((member) => ({ id: member.id, email: member.email }));

			const uniqueAdmins = Array.from(new Map(admins.map((admin) => [admin.id, admin])).values());

			logger.debug('Retrieved admin users', {
				count: uniqueAdmins.length,
				adminGroup: adminGroupName,
			});

			return uniqueAdmins;
		} catch (error) {
			logger.error('Failed to retrieve admin users from EPFL API', { error: error.message });
			throw error;
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
				throw new Error(`Allowed units file does not exist: ${allowedUnitsFile}`);
			}

			const fileContent = fs.readFileSync(allowedUnitsFile, 'utf8');
			const allowedUnits = JSON.parse(fileContent);

			if (!Array.isArray(allowedUnits)) {
				throw new Error('Invalid format: Expected an array of units in the file');
			}

			logger.debug('Retrieved allowed units', { count: allowedUnits.length });
			return allowedUnits;
		} catch (err) {
			logger.error('Failed to read allowed units file', { error: err.message });
			throw err;
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
		try {
			const response = await this._makeOutlineApiCall('POST', '/api/collections.list', {});
			const collections = response.data;

			logger.debug('Retrieved collections', { count: collections.length });
			return collections;
		} catch (error) {
			logger.error('Failed to retrieve collections from Outline API', { error: error.message });
			throw error;
		}
	}

	/**
	 * Find a user by email
	 * @param {String} email - User email
	 * @returns {Object|null} - User object or null if not found
	 */
	async findUserByEmail(email) {
		try {
			const users = await this.getAllUsers();
			return users.find((u) => u.email === email) || null;
		} catch (error) {
			logger.error(`Failed to find user by email ${email}`, { error: error.message });
			throw error;
		}
	}

	/**
	 * Find a user by ID
	 * @param {String} userId - User ID
	 * @returns {Object|null} - User object or null if not found
	 * */
	async findUserById(userId) {
		try {
			const users = await this.getAllUsers();
			return users.find((u) => u.id === userId) || null;
		} catch (error) {
			logger.error(`Failed to find user by ID ${userId}`, { error: error.message });
			throw error;
		}
	}

	/**
	 * Find a group by name (case-insensitive)
	 * @param {String} name - Group name
	 * @returns {Object|null} - Group object or null if not found
	 */
	async findGroupByName(name) {
		try {
			const groups = await this.getAllGroups();

			let group = groups.find((g) => g.name === name);
			if (group) return group;

			return groups.find((g) => g.name.toLowerCase() === name.toLowerCase()) || null;
		} catch (error) {
			logger.error(`Failed to find group by name ${name}`, { error: error.message });
			throw error;
		}
	}

	/**
	 * Find a collection by name (case-insensitive)
	 * @param {String} name - Collection name
	 * @returns {Object|null} - Collection object or null if not found
	 */
	async findCollectionByName(name) {
		try {
			const collections = await this.getAllCollections();

			let collection = collections.find((c) => c.name === name);
			if (collection) return collection;

			return collections.find((c) => c.name.toLowerCase() === name.toLowerCase()) || null;
		} catch (error) {
			logger.error(`Failed to find collection by name ${name}`, { error: error.message });
			throw error;
		}
	}

	/**
	 * Create a new group
	 * @param {String} name - Group name
	 * @returns {Object} - Created group
	 */
	async createGroup(name) {
		try {
			const response = await this.outlineClient.post('/api/groups.create', { name });
			logger.info('Group created', {
				groupId: response.data.data.id,
				groupName: name,
			});
			return response.data.data;
		} catch (error) {
			logger.error(`Failed to create group ${name}`, { error: error.message });
			throw error;
		}
	}

	/**
	 * Update a group's name
	 * @param {String} groupId - Group ID
	 * @param {String} newName - New group name
	 * @returns {Object} - Updated group
	 */
	async updateGroupName(groupId, newName) {
		try {
			const response = await this.outlineClient.post('/api/groups.update', {
				id: groupId,
				name: newName,
			});
			logger.info('Group name updated', {
				groupId,
				newName,
			});
			return response.data.data;
		} catch (error) {
			logger.error(`Failed to update group ${groupId} name to ${newName}`, { error: error.message });
			throw error;
		}
	}

	/**
	 * Create a new collection
	 * @param {String} name - Collection name
	 * @param {Boolean} isPrivate - Whether the collection is private
	 * @returns {Object} - Created collection
	 */
	async createCollection(name, isPrivate = false) {
		try {
			const response = await this.outlineClient.post('/api/collections.create', {
				name,
				permission: 'read',
				private: isPrivate,
			});

			const collectionId = response.data.data.id;
			logger.info('Collection created', { collectionId, collectionName: name });
			return response.data.data;
		} catch (error) {
			logger.error(`Failed to create collection ${name}`, { error: error.message });
			throw error;
		}
	}

	/**
	 * Update a collection's name and privacy
	 * @param {String} collectionId - Collection ID
	 * @param {String} newName - New collection name
	 * @param {Boolean} isPrivate - Whether the collection is private
	 * @returns {Object} - Updated collection
	 */
	async updateCollection(collectionId, newName, isPrivate = true) {
		try {
			const response = await this.outlineClient.post('/api/collections.update', {
				id: collectionId,
				name: newName,
				private: isPrivate,
			});
			logger.info('Collection updated', {
				collectionId,
				newName,
				isPrivate,
			});
			return response.data.data;
		} catch (error) {
			logger.error(`Failed to update collection ${collectionId}`, { error: error.message });
			throw error;
		}
	}

	/**
	 * Check if a user is already in a group
	 * @param {String} userId - User ID
	 * @param {String} groupId - Group ID
	 * @returns {Boolean} - Whether the user is already in the group
	 */
	async isUserInGroup(userId, groupId) {
		try {
			const groupMembers = await this.getGroupMembers(groupId);
			return groupMembers.some(member => member.id === userId);
		} catch (error) {
			logger.debug(`Failed to check user membership in group ${groupId}`, { error: error.message });
			return false;
		}
	}

	/**
	 * Add a user to a group
	 * @param {String} userId - User ID
	 * @param {String} groupId - Group ID
	 * @returns {Boolean} - Success status
	 */
	async addUserToGroup(userId, groupId) {
		try {
			const isAlreadyInGroup = await this.isUserInGroup(userId, groupId);
			if (isAlreadyInGroup) {
				logger.debug('User already in group', { groupId, userId });
				return true;
			}

			await this.outlineClient.post('/api/groups.add_user', { id: groupId, userId });
			logger.info('User added to group', { groupId, userId });
			return true;
		} catch (error) {
			logger.error(`Failed to add user ${userId} to group ${groupId}`, { error: error.message });
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
		try {
			const response = await this.outlineClient.post('/api/users.info', { id: userId });
			const currentRole = response.data.data.role;

			if (currentRole === 'admin') {
				logger.debug('User already has admin role', { userId, email });
				return true;
			}

			await this.outlineClient.post('/api/users.update_role', { id: userId, role: 'admin' });
			logger.info('User promoted to admin', { userId, email });
			return true;
		} catch (error) {
			logger.error(`Failed to make user ${email} admin`, { userId, error: error.message });
			throw error;
		}
	}

	/**
	 * Remove admin role from user
	 * @param {String} userId - User ID
	 * @param {String} email - User email for logging
	 * @returns {Boolean} - Success status
	 */
	async removeUserAdmin(userId, email) {
		try {
			const response = await this.outlineClient.post('/api/users.info', { id: userId });
			const currentRole = response.data.data.role;

			if (currentRole !== 'admin') {
				logger.debug('User is not an admin, no action needed', { userId, email });
				return true;
			}

			await this.outlineClient.post('/api/users.update_role', { id: userId, role: 'viewer' });
			logger.info('Admin role removed from user', { userId, email });
			return true;
		} catch (error) {
			logger.error(`Failed to remove admin role from user ${email}`, { userId, error: error.message });
			throw error;
		}
	}

	/**
	 * Check if a group is already in a collection
	 * @param {String} groupId - Group ID
	 * @param {String} collectionId - Collection ID
	 * @returns {Boolean} - Whether the group is already in the collection
	 */
	async isGroupInCollection(groupId, collectionId) {
		try {
			const response = await this._makeOutlineApiCall('POST', '/api/collections.group_memberships', { id: collectionId });
			const groups = response.data.flatMap(item => item.groups || []);
			return groups.some(group => group.id === groupId);
		} catch (error) {
			logger.debug(`Failed to check group membership in collection ${collectionId}`, { error: error.message });
			return false;
		}
	}

	/**
	 * Add group to a collection
	 * @param {String} groupId - Group ID
	 * @param {String} collectionId - Collection ID
	 * @param {String} permission - Permission level (read, read_write, etc.)
	 * @returns {Boolean} - Success status
	 */
	async addGroupToCollection(groupId, collectionId, permission = 'read_write') {
		try {
			const isAlreadyInCollection = await this.isGroupInCollection(groupId, collectionId);
			if (isAlreadyInCollection) {
				logger.debug('Group already in collection', { groupId, collectionId });
				return true;
			}

			await this.outlineClient.post('/api/collections.add_group', {
				id: collectionId,
				groupId,
				permission,
			});
			logger.info('Group added to collection', { groupId, collectionId, permission });
			return true;
		} catch (error) {
			logger.error(`Failed to add group ${groupId} to collection ${collectionId}`, { error: error.message });
			throw error;
		}
	}

	/**
	 * Make collection private
	 * @param {String} collectionId - Collection ID
	 * @returns {Boolean} - Success status
	 */
	async makeCollectionPrivate(collectionId) {
		try {
			await this.outlineClient.post('/api/collections.update', {
				id: collectionId,
				permission: null,
			});
			logger.info('Collection made private', { collectionId });
			return true;
		} catch (error) {
			logger.error(`Failed to make collection ${collectionId} private`, { error: error.message });
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
		try {
			await this.outlineClient.post('/api/groups.remove_user', { id: groupId, userId });
			logger.info('User removed from group', { groupId, userId });
			return true;
		} catch (error) {
			logger.error(`Failed to remove user ${userId} from group ${groupId}`, { error: error.message });
			throw error;
		}
	}

	/**
	 * Get members of a group
	 * @param {String} groupId - Group ID
	 * @returns {Array} - List of users in the group
	 */
	async getGroupMembers(groupId) {
		try {
			const response = await this._makeOutlineApiCall('POST', '/api/groups.memberships', { id: groupId });
			const users = response.data.flatMap(item => item.users || []);
			return users;
		} catch (error) {
			logger.error(`Failed to get members of group ${groupId}`, { error: error.message });
			throw error;
		}
	}

	/**
	 * Get all admin users
	 * @returns {Array} - List of admin users
	 */
	async getAllAdminUsers() {
		try {
			const response = await this._makeOutlineApiCall('POST', '/api/users.list', { role: 'admin' });
			return response.data.filter((user) => user.email !== this.ADMIN_EMAIL);
		} catch (error) {
			logger.error('Failed to get admin users from Outline', { error: error.message });
			throw error;
		}
	}

	/**
	 * Delete a group
	 * @param {String} groupId - Group ID
	 * @returns {Boolean} - Success status
	 */
	async deleteGroup(groupId) {
		try {
			await this.outlineClient.post('/api/groups.delete', { id: groupId });
			logger.info('Group deleted', { groupId });
			return true;
		} catch (error) {
			logger.error(`CRITICAL: Failed to delete group ${groupId}`, { error: error.message });
			throw error;
		}
	}

	/**
	 * Delete a collection
	 * @param {String} collectionId - Collection ID
	 * @returns {Boolean} - Success status
	 */
	async deleteCollection(collectionId) {
		try {
			await this.outlineClient.post('/api/collections.delete', { id: collectionId });
			logger.info('Collection deleted', { collectionId });
			return true;
		} catch (error) {
			logger.error(`CRITICAL: Failed to delete collection ${collectionId}`, { error: error.message });
			throw error;
		}
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
	 */
	async syncUsers() {
		const activeUsers = await this.getAllUsers();
		const existingGroups = await this.getAllGroups();
		const allowedUnits = await this.getAllowedUnits();

		if (!activeUsers.length) {
			logger.warn('No active users found, sync cannot proceed');
			throw new Error('No active users found');
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
				logger.info('Obsolete group deleted', { groupName: group.name });
			}
		}

		for (const group of existingGroups) {
			const groupName = group.name;

			const groupMembers = await this.getGroupMembers(group.id);

			if (groupName.toLowerCase() === this.ADMIN_GROUP_NAME.toLowerCase()) {
				for (const member of groupMembers) {
					const user = await this.findUserById(member.id);
					const isAdmin = admins.some((admin) => admin.email === user.email);
					if (!isAdmin) {
						await this.removeUserFromGroup(member.id, group.id);
					}
				}
			} else {
				for (const member of groupMembers) {
					const user = activeUsers.find((u) => u.id === member.id);
					if (!user) continue;

					const memberUnits = userUnitsMap[user.email] || [];
					const shouldBeInGroup = memberUnits.some((unit) => unit.name.toLowerCase() === groupName.toLowerCase());

					if (!shouldBeInGroup) {
						logger.debug('Removing user from obsolete group', {
							email: user.email,
							groupName: group.name,
						});
						await this.removeUserFromGroup(member.id, group.id);
					}
				}
			}
		}

		logger.info('User synchronization completed successfully');
	}

	/**
	 * Create or get the admin group
	 * @returns {Object} - Admin group
	 */
	async ensureAdminGroup() {
		try {
			let adminGroup = await this.findGroupByName(this.ADMIN_GROUP_NAME);

			if (!adminGroup) {
				adminGroup = await this.createGroup(this.ADMIN_GROUP_NAME);
			}

			return adminGroup;
		} catch (error) {
			logger.error('CRITICAL: Failed to ensure admin group exists', { error: error.message });
			throw error;
		}
	}

	/**
	 * Synchronize admin users
	 */
	async syncAdmins() {
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
	}

	/**
	 * Synchronize collections based on groups
	 */
	async syncCollections() {
		const groups = await this.getAllGroups();
		const collections = await this.getAllCollections();
		await this.ensureAdminGroup();

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
				logger.info('Obsolete collection deleted', {
					collectionName: collection.name,
				});
			}
		}

		logger.info('Collection synchronization completed successfully');
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
		await outlineSync.syncUsers();

		logger.info('Starting admin synchronization process');
		await outlineSync.syncAdmins();

		logger.info('Starting collection synchronization process');
		await outlineSync.syncCollections();

		logger.info('Complete synchronization process finished successfully');
	} catch (error) {
		exitCode = 1;
		logger.error('Synchronization failed - script terminated', {
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
