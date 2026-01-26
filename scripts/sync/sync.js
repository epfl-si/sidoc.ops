const axios = require('axios');
const https = require('https');
const fs = require('fs');
require('dotenv').config();

const logger = {
	_log: (level, message, data = {}) => {
		console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...data }));
	},
	info: (msg, data) => logger._log('INFO', msg, data),
	warn: (msg, data) => logger._log('WARN', msg, data),
	error: (msg, data) => logger._log('ERROR', msg, data),
	debug: (msg, data) => process.env.DEBUG === 'true' && logger._log('DEBUG', msg, data),
};

/**
 * OutlineSync - Synchronization utility for Outline Wiki
 * Handles user/group sync, admin sync, collections sync, and sidoc.readwrite authorizations
 */
class OutlineSync {
	constructor() {
		this._validateEnv();
		this._initClients();
		this._initCache();
		this._initConfig();
	}

	_validateEnv() {
		const required = ['OUTLINE_BASE_URL', 'OUTLINE_API_TOKEN', 'EPFL_API_URL', 'EPFL_API_USERNAME', 'EPFL_API_PASSWORD', 'OUTLINE_ADMIN_GROUP'];
		const missing = required.filter((v) => !process.env[v]);
		if (missing.length) throw new Error(`Missing env vars: ${missing.join(', ')}`);
	}

	_initClients() {
		const agent = new https.Agent({ rejectUnauthorized: false });

		this.outline = axios.create({
			baseURL: process.env.OUTLINE_BASE_URL,
			headers: { Authorization: `Bearer ${process.env.OUTLINE_API_TOKEN}`, 'Content-Type': 'application/json' },
			httpsAgent: agent,
			timeout: 10000,
		});

		this.epfl = axios.create({
			baseURL: process.env.EPFL_API_URL,
			headers: { Authorization: `Basic ${Buffer.from(`${process.env.EPFL_API_USERNAME}:${process.env.EPFL_API_PASSWORD}`).toString('base64')}` },
			timeout: 10000,
		});

		[['Outline', this.outline], ['EPFL', this.epfl]].forEach(([name, client]) => {
			client.interceptors.request.use(
				(config) => {
					logger.debug(`${name} API Request`, { method: config.method, url: config.url });
					return config;
				},
				(error) => {
					logger.error(`${name} API Request Error`, { message: error.message, stack: error.stack });
					return Promise.reject(error);
				}
			);
			client.interceptors.response.use(
				(response) => response,
				(error) => {
					if (error.response) {
						logger.error(`${name} API Response Error`, { status: error.response.status, data: error.response.data });
					} else if (error.request) {
						logger.error(`${name} No Response Received`, { request: error.request });
					} else {
						logger.error(`${name} Request Setup Error`, { message: error.message });
					}
					return Promise.reject(error);
				}
			);
		});
	}

	_initCache() {
		this.cache = { users: null, groups: null, collections: null, allowedUnits: null };
	}

	_initConfig() {
		this.ADMIN_EMAIL = process.env.OUTLINE_ADMIN_EMAIL || 'admin@epfl.ch';
		this.ADMIN_GROUP = 'admins';
		this.ALLOWED_COLLECTIONS = (process.env.ALLOWED_COLLECTIONS || 'welcome').split(',').map((s) => s.toLowerCase());
		this.ACCESS_GROUP = process.env.EPFL_ACCESS_GROUP;
	}

	/**
	 * Make paginated POST request to Outline API
	 * @param {string} endpoint - API endpoint
	 * @param {object} data - Request data
	 * @returns {Array} - All results
	 */
	async _outlinePost(endpoint, data = {}) {
		let results = [];
		let offset = 0;
		const limit = 100;
		let total = null;

		do {
			const res = await this.outline.post(endpoint, { ...data, limit, offset });
			const pageData = res.data.data || [];
			results = results.concat(pageData);

			const pagination = res.data.pagination;
			if (pagination) {
				total = pagination.total;
				offset += limit;
			} else {
				break;
			}
		} while (total !== null && results.length < total);

		return results;
	}

	/**
	 * Get all Outline users (cached)
	 * @param {boolean} refresh - Force refresh cache
	 * @returns {Array} - Users list
	 */
	async getUsers(refresh = false) {
		if (!this.cache.users || refresh) {
			logger.info('Fetching users from Outline API');
			const all = await this._outlinePost('/api/users.list');
			this.cache.users = all.filter((u) => u.email !== this.ADMIN_EMAIL);
			logger.info('Users fetched and cached', { count: this.cache.users.length });
		}
		return this.cache.users;
	}

	/**
	 * Get all Outline groups (cached)
	 * @param {boolean} refresh - Force refresh cache
	 * @returns {Array} - Groups list
	 */
	async getGroups(refresh = false) {
		if (!this.cache.groups || refresh) {
			logger.info('Fetching groups from Outline API');
			const raw = await this._outlinePost('/api/groups.list');
			this.cache.groups = raw.flatMap((d) => d.groups || d);
			logger.info('Groups fetched and cached', { count: this.cache.groups.length });
		}
		return this.cache.groups;
	}

	/**
	 * Get all Outline collections (cached)
	 * @param {boolean} refresh - Force refresh cache
	 * @returns {Array} - Collections list
	 */
	async getCollections(refresh = false) {
		if (!this.cache.collections || refresh) {
			logger.info('Fetching collections from Outline API');
			this.cache.collections = await this._outlinePost('/api/collections.list');
			logger.info('Collections fetched and cached', { count: this.cache.collections.length });
		}
		return this.cache.collections;
	}

	/**
	 * Get allowed units from config file
	 * @returns {Array|false} - Allowed units or false if all allowed
	 */
	async getAllowedUnits() {
		if (this.cache.allowedUnits !== null) return this.cache.allowedUnits;

		const file = process.env.EPFL_ALLOWED_UNITS_FILE;
		if (!file) {
			logger.info('No allowed units file configured, all units allowed');
			this.cache.allowedUnits = false;
			return false;
		}

		logger.info('Loading allowed units from file', { file });
		const content = fs.readFileSync(file, 'utf8');
		this.cache.allowedUnits = JSON.parse(content).map((u) => u.toLowerCase());
		logger.info('Allowed units loaded', { count: this.cache.allowedUnits.length });
		return this.cache.allowedUnits;
	}

	/**
	 * Check if unit is in allowed list
	 * @param {string} name - Unit name
	 * @param {Array|false} allowed - Allowed units
	 * @returns {boolean}
	 */
	isUnitAllowed(name, allowed) {
		return allowed === false || allowed.includes(name.toLowerCase());
	}

	/**
	 * Find Outline user by email
	 * @param {string} email
	 * @returns {object|null}
	 */
	async findUser(email) {
		const users = await this.getUsers();
		const user = users.find((u) => u.email.toLowerCase() === email.toLowerCase()) || null;
		logger.info('User lookup', { email, found: !!user });
		return user;
	}

	/**
	 * Find Outline group by name
	 * @param {string} name
	 * @returns {object|null}
	 */
	async findGroup(name) {
		const groups = await this.getGroups();
		const group = groups.find((g) => g.name.toLowerCase() === name.toLowerCase()) || null;
		logger.info('Group lookup', { name, found: !!group });
		return group;
	}

	/**
	 * Find Outline collection by name
	 * @param {string} name
	 * @returns {object|null}
	 */
	async findCollection(name) {
		const collections = await this.getCollections();
		const collection = collections.find((c) => c.name.toLowerCase() === name.toLowerCase()) || null;
		logger.info('Collection lookup', { name, found: !!collection });
		return collection;
	}

	/**
	 * Get members of an Outline group
	 * @param {string} groupId
	 * @returns {Array}
	 */
	async getGroupMembers(groupId) {
		logger.info('Fetching group members from Outline', { groupId });
		const raw = await this._outlinePost('/api/groups.memberships', { id: groupId });
		const members = raw.flatMap((item) => item.users || []);
		logger.info('Group members fetched', { groupId, count: members.length });
		return members;
	}

	/**
	 * Create Outline group
	 * @param {string} name
	 * @returns {object} - Created group
	 */
	async createGroup(name) {
		const res = await this.outline.post('/api/groups.create', { name });
		const group = res.data.data;
		logger.info('Group created', { name, id: group.id });
		this.cache.groups = null;
		return group;
	}

	/**
	 * Delete Outline group
	 * @param {string} id
	 * @param {string} name
	 */
	async deleteGroup(id, name) {
		await this.outline.post('/api/groups.delete', { id });
		logger.info('Group deleted', { name, id });
		this.cache.groups = null;
	}

	/**
	 * Add user to Outline group
	 * @param {string} userId
	 * @param {string} groupId
	 * @returns {boolean} - true if added, false if already member
	 */
	async addUserToGroup(userId, groupId) {
		const members = await this.getGroupMembers(groupId);
		if (members.some((m) => m.id === userId)) {
			logger.info('User already in group', { userId, groupId });
			return false;
		}
		await this.outline.post('/api/groups.add_user', { id: groupId, userId });
		return true;
	}

	/**
	 * Remove user from Outline group
	 * @param {string} userId
	 * @param {string} groupId
	 */
	async removeUserFromGroup(userId, groupId) {
		await this.outline.post('/api/groups.remove_user', { id: groupId, userId });
	}

	/**
	 * Create Outline collection
	 * @param {string} name
	 * @returns {object} - Created collection
	 */
	async createCollection(name) {
		const res = await this.outline.post('/api/collections.create', { name, permission: 'read', private: false });
		const collection = res.data.data;
		logger.info('Collection created', { name, id: collection.id });
		this.cache.collections = null;
		return collection;
	}

	/**
	 * Delete Outline collection
	 * @param {string} id
	 * @param {string} name
	 */
	async deleteCollection(id, name) {
		await this.outline.post('/api/collections.delete', { id });
		logger.info('Collection deleted', { name, id });
		this.cache.collections = null;
	}

	/**
	 * Add group to collection
	 * @param {string} groupId
	 * @param {string} collectionId
	 * @returns {boolean} - true if linked, false if already linked
	 */
	async addGroupToCollection(groupId, collectionId) {
		logger.info('Fetching collection group memberships', { collectionId });
		const raw = await this._outlinePost('/api/collections.group_memberships', { id: collectionId });
		const existing = raw.flatMap((item) => item.groups || []);
		logger.info('Collection group memberships fetched', { collectionId, count: existing.length });
		if (existing.some((g) => g.id === groupId)) return false;
		await this.outline.post('/api/collections.add_group', { id: collectionId, groupId, permission: 'read_write' });
		logger.info('Group linked to collection', { groupId, collectionId });
		return true;
	}

	/**
	 * Set user admin role
	 * @param {string} userId
	 * @param {string} email
	 * @param {boolean} isAdmin
	 * @returns {boolean} - true if changed, false if no change needed
	 */
	async setUserAdmin(userId, email, isAdmin) {
		logger.info('Fetching user info from Outline', { userId, email });
		const res = await this.outline.post('/api/users.info', { id: userId });
		const current = res.data.data.role;
		logger.info('User info fetched', { userId, email, currentRole: current });
		const target = isAdmin ? 'admin' : 'viewer';
		if ((isAdmin && current === 'admin') || (!isAdmin && current !== 'admin')) return false;
		await this.outline.post('/api/users.update_role', { id: userId, role: target });
		logger.info(isAdmin ? 'User promoted to admin' : 'Admin role removed', { email, userId });
		return true;
	}

	/**
	 * Suspend Outline user
	 * @param {string} userId
	 * @param {string} email
	 */
	async suspendUser(userId, email) {
		await this.outline.post('/api/users.suspend', { id: userId });
		logger.info('User suspended', { email, userId });
	}

	/**
	 * Get person from EPFL API
	 * @param {string|number} identifier - Email or SCIPER
	 * @returns {object|null}
	 */
	async epflGetPerson(identifier) {
		logger.info('Fetching person from EPFL API', { identifier });
		try {
			const res = await this.epfl.get(`/persons/${identifier}`);
			logger.info('Person fetched from EPFL', { identifier, email: res.data.email });
			return res.data;
		} catch (err) {
			if (err.response?.status === 404) {
				logger.info('Person not found in EPFL', { identifier });
				return null;
			}
			throw err;
		}
	}

	/**
	 * Get user units from EPFL API
	 * @param {string} email
	 * @returns {Array|null} - null if user not found
	 */
	async epflGetUserUnits(email) {
		const person = await this.epflGetPerson(email);
		if (!person) return null;
		logger.info('Fetching units for user from EPFL', { email, persid: person.id });
		const res = await this.epfl.get(`/units?persid=${person.id}`);
		const units = res.data.units || [];
		logger.info('User units fetched from EPFL', { email, count: units.length });
		return units;
	}

	/**
	 * Get EPFL group members
	 * @param {string} group
	 * @returns {Array}
	 */
	async epflGetGroupMembers(group) {
		logger.info('Fetching group members from EPFL API', { group });
		const res = await this.epfl.get(`/groups/${group}/members?recursive=1`);
		const members = (res.data.members || []).filter((m) => m.type === 'person');
		logger.info('EPFL group members fetched', { group, count: members.length });
		return members;
	}

	/**
	 * Get sidoc.readwrite authorizations from EPFL API
	 * @returns {Array}
	 */
	async epflGetAuthorizations() {
		logger.info('Fetching sidoc.readwrite authorizations from EPFL API');
		const res = await this.epfl.get('/authorizations', { params: { authid: 'sidoc.readwrite', type: 'right' } });
		const auths = res.data.authorizations || [];
		logger.info('Authorizations fetched from EPFL', { count: auths.length });
		return auths;
	}

	/**
	 * Add users to EPFL group
	 * @param {Array} scipers
	 * @param {string} group
	 */
	async epflAddToGroup(scipers, group) {
		if (!scipers.length) return;
		await this.epfl.post(`/groups/${group}/members`, { ids: scipers.join(',') });
		logger.info('Users added to EPFL group', { group, count: scipers.length, scipers });
	}

	/**
	 * Remove user from EPFL group
	 * @param {number} sciper
	 * @param {string} group
	 */
	async epflRemoveFromGroup(sciper, group) {
		await this.epfl.delete(`/groups/${group}/members/${sciper}`);
		logger.info('User removed from EPFL group', { group, sciper });
	}

	/**
	 * Sync users based on unit accreditation
	 */
	async syncUsers() {
		const users = await this.getUsers(true);
		const groups = await this.getGroups();
		const allowedUnits = await this.getAllowedUnits();

		logger.info('Starting user synchronization', {
			users: users.length,
			groups: groups.length,
			allowedUnits: allowedUnits === false ? 'all' : allowedUnits.length,
		});

		const stats = { processed: 0, suspended: 0, groupsCreated: 0, added: 0, removed: 0 };
		const userUnitsMap = new Map();
		const validGroups = new Set([this.ADMIN_GROUP.toLowerCase()]);

		for (const user of users) {
			const units = await this.epflGetUserUnits(user.email);

			if (units === null) {
				logger.warn('User no longer exists in EPFL, suspending', { email: user.email, userId: user.id });
				await this.suspendUser(user.id, user.email);
				stats.suspended++;
				userUnitsMap.set(user.email, []);
				continue;
			}

			const filtered = units.filter((u) => this.isUnitAllowed(u.name, allowedUnits));
			userUnitsMap.set(user.email, filtered);
			stats.processed++;

			logger.info('Retrieved units for user', { email: user.email, total: units.length, allowed: filtered.length });
		}

		logger.info('Unit data retrieval completed', { users: users.length, unitsFound: stats.processed });

		for (const user of users) {
			const units = userUnitsMap.get(user.email) || [];
			logger.info('Processing user units', { email: user.email, units: units.length });

			for (const unit of units) {
				let group = await this.findGroup(unit.name);
				if (!group) {
					group = await this.createGroup(unit.name);
					stats.groupsCreated++;
				}

				const added = await this.addUserToGroup(user.id, group.id);
				if (added) {
					logger.info('User added to group', { email: user.email, group: unit.name });
					stats.added++;
				}

				validGroups.add(unit.name.toLowerCase());
			}
		}

		const allGroups = await this.getGroups(true);
		for (const group of allGroups) {
			const nameLower = group.name.toLowerCase();
			if (nameLower === this.ADMIN_GROUP.toLowerCase()) continue;

			if (!validGroups.has(nameLower)) {
				const members = await this.getGroupMembers(group.id);
				if (members.length === 0) {
					await this.deleteGroup(group.id, group.name);
					logger.info('Obsolete empty group deleted', { group: group.name });
				} else {
					logger.debug('Group not deleted - has members', { group: group.name, members: members.length });
				}
				continue;
			}

			const members = await this.getGroupMembers(group.id);
			for (const member of members) {
				const user = users.find((u) => u.id === member.id);
				if (!user) continue;

				const userUnits = userUnitsMap.get(user.email) || [];
				const shouldBeIn = userUnits.some((u) => u.name.toLowerCase() === nameLower);

				if (!shouldBeIn) {
					await this.removeUserFromGroup(member.id, group.id);
					stats.removed++;
					logger.info('User removed from group', { email: user.email, group: group.name });
				}
			}
		}

		logger.info('User synchronization completed', stats);
	}

	/**
	 * Sync users with sidoc.readwrite authorization
	 */
	async syncAuthorizedUsers() {
		const allowedUnits = await this.getAllowedUnits();
		const auths = await this.epflGetAuthorizations();

		logger.info('Starting authorized users synchronization', { authorizations: auths.length });

		const validAuths = auths.filter((a) => {
			const unit = a.reason?.resource?.name;
			return unit && this.isUnitAllowed(unit, allowedUnits);
		});

		logger.info('Filtered authorizations', { total: auths.length, valid: validAuths.length });

		const byUnit = new Map();
		const allScipers = new Set();

		for (const auth of validAuths) {
			const unit = auth.reason.resource.name;
			const sciper = Number(auth.persid);
			if (!byUnit.has(unit)) byUnit.set(unit, new Set());
			byUnit.get(unit).add(sciper);
			allScipers.add(sciper);
		}

		if (this.ACCESS_GROUP) {
			const existing = (await this.epflGetGroupMembers(this.ACCESS_GROUP)).map((m) => Number(m.id));
			const authorized = [...allScipers];
			const toAdd = authorized.filter((s) => !existing.includes(s));
			const toRemove = existing.filter((s) => !authorized.includes(s));

			logger.info('Syncing EPFL externals group', {
				group: this.ACCESS_GROUP,
				existing: existing.length,
				authorized: authorized.length,
				toAdd: toAdd.length,
				toRemove: toRemove.length,
			});

			if (toAdd.length) await this.epflAddToGroup(toAdd, this.ACCESS_GROUP);
			for (const sciper of toRemove) await this.epflRemoveFromGroup(sciper, this.ACCESS_GROUP);
		}

		const stats = { groupsCreated: 0, added: 0 };

		for (const [unit, scipers] of byUnit) {
			const outlineUsers = [];
			for (const sciper of scipers) {
				const person = await this.epflGetPerson(sciper);
				if (!person?.email) {
					logger.warn('Could not retrieve email for authorized user', { sciper });
					continue;
				}

				const user = await this.findUser(person.email);
				if (user) {
					outlineUsers.push({ user, email: person.email });
				} else {
					logger.debug('Authorized user not found in Outline', { email: person.email, sciper });
				}
			}

			if (!outlineUsers.length) {
				logger.debug('No Outline users for unit, skipping', { unit });
				continue;
			}

			let group = await this.findGroup(unit);
			if (!group) {
				group = await this.createGroup(unit);
				stats.groupsCreated++;
			}

			for (const { user, email } of outlineUsers) {
				const added = await this.addUserToGroup(user.id, group.id);
				if (added) {
					stats.added++;
					logger.info('Authorized user added to group', { email, group: unit });
				}
			}
		}

		logger.info('Authorized users synchronization completed', { units: byUnit.size, users: allScipers.size, ...stats });
	}

	/**
	 * Sync admin users
	 */
	async syncAdmins() {
		const epflAdmins = await this.epflGetGroupMembers(process.env.OUTLINE_ADMIN_GROUP);
		const adminEmails = new Set(epflAdmins.map((a) => a.email.toLowerCase()));

		let adminGroup = await this.findGroup(this.ADMIN_GROUP);
		if (!adminGroup) adminGroup = await this.createGroup(this.ADMIN_GROUP);

		const allUsers = await this.getUsers();
		const currentAdmins = (await this._outlinePost('/api/users.list', { role: 'admin' })).filter((u) => u.email !== this.ADMIN_EMAIL);

		logger.info('Starting admin synchronization', { epflAdmins: epflAdmins.length, currentAdmins: currentAdmins.length });

		const stats = { promoted: 0, demoted: 0, addedToGroup: 0, removedFromGroup: 0 };

		for (const admin of epflAdmins) {
			const user = await this.findUser(admin.email);
			if (!user) {
				logger.warn('Admin not found in Outline', { email: admin.email });
				continue;
			}

			const added = await this.addUserToGroup(user.id, adminGroup.id);
			if (added) {
				logger.info('Admin added to group', { email: admin.email });
				stats.addedToGroup++;
			}

			const promoted = await this.setUserAdmin(user.id, admin.email, true);
			if (promoted) stats.promoted++;
		}

		for (const admin of currentAdmins) {
			if (!adminEmails.has(admin.email.toLowerCase())) {
				await this.setUserAdmin(admin.id, admin.email, false);
				await this.removeUserFromGroup(admin.id, adminGroup.id);
				logger.info('Admin demoted', { email: admin.email });
				stats.demoted++;
				stats.removedFromGroup++;
			}
		}

		const members = await this.getGroupMembers(adminGroup.id);
		for (const member of members) {
			const user = allUsers.find((u) => u.id === member.id);
			if (user && !adminEmails.has(user.email.toLowerCase())) {
				await this.removeUserFromGroup(member.id, adminGroup.id);
				logger.info('User removed from admin group', { email: user.email });
				stats.removedFromGroup++;
			}
		}

		logger.info('Admin synchronization completed', stats);
	}

	/**
	 * Sync collections based on groups
	 */
	async syncCollections() {
		const groups = await this.getGroups(true);
		const collections = await this.getCollections(true);

		logger.info('Starting collection synchronization', { groups: groups.length, collections: collections.length });

		const groupNames = new Set(groups.filter((g) => g.name.toLowerCase() !== this.ADMIN_GROUP.toLowerCase()).map((g) => g.name.toLowerCase()));
		const stats = { created: 0, linked: 0, deleted: 0 };

		for (const group of groups) {
			if (group.name.toLowerCase() === this.ADMIN_GROUP.toLowerCase()) continue;

			let collection = await this.findCollection(group.name);
			if (!collection) {
				collection = await this.createCollection(group.name);
				stats.created++;
			}

			const linked = await this.addGroupToCollection(group.id, collection.id);
			if (linked) stats.linked++;
		}

		for (const collection of collections) {
			const name = collection.name.toLowerCase();
			if (name === this.ADMIN_GROUP.toLowerCase()) continue;
			if (this.ALLOWED_COLLECTIONS.includes(name)) continue;
			if (groupNames.has(name)) continue;

			await this.deleteCollection(collection.id, collection.name);
			logger.info('Obsolete collection deleted', { collection: collection.name });
			stats.deleted++;
		}

		logger.info('Collection synchronization completed', stats);
	}

	/**
	 * Run full synchronization
	 */
	async run() {
		logger.info('Starting user synchronization process');
		await this.syncUsers();

		logger.info('Starting authorized users synchronization process');
		await this.syncAuthorizedUsers();

		logger.info('Starting admin synchronization process');
		await this.syncAdmins();

		logger.info('Starting collection synchronization process');
		await this.syncCollections();

		logger.info('Complete synchronization process finished successfully');
	}
}

async function main() {
	let exitCode = 0;
	try {
		const sync = new OutlineSync();
		await sync.run();
	} catch (error) {
		exitCode = 1;
		logger.error('Synchronization failed', { error: error.message, stack: error.stack });
	} finally {
		logger.info(`Process exiting with code: ${exitCode}`);
		process.exit(exitCode);
	}
}

main();
