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

const AUTHORIZATION_ID = 'sidoc.readwrite';
const MAX_CONSECUTIVE_EPFL_ERRORS = 5;

/**
 * OutlineSync - Synchronization utility for Outline Wiki
 * Handles user/group sync, admin sync, collections sync, and sidoc.readwrite authorizations
 *
 * Users are matched to the EPFL directory by SCIPER: each Outline user is resolved once
 * (see epflFindPersonForEmail), then accreditations, authorizations and admin rights
 * are all expressed as SCIPERs and mapped back to Outline users.
 *
 * Optional environment:
 *   MAX_SUSPENSIONS=5                  suspend nobody if more users than this would be suspended in one run
 *   FORCE_SUSPEND=true                 ignore MAX_SUSPENSIONS
 *   OUTLINE_SSO_EMAIL_DOMAIN=epfl.ch   domain of the SSO e-mail, used to match accounts by username
 *   OUTLINE_TLS_INSECURE=true          skip TLS verification for the Outline API
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
		const insecure = process.env.OUTLINE_TLS_INSECURE === 'true';
		if (insecure) logger.warn('TLS verification is disabled for the Outline API');

		this.outline = axios.create({
			baseURL: process.env.OUTLINE_BASE_URL,
			headers: { Authorization: `Bearer ${process.env.OUTLINE_API_TOKEN}`, 'Content-Type': 'application/json' },
			httpsAgent: insecure ? new https.Agent({ rejectUnauthorized: false }) : undefined,
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
						// error.request is a circular socket object: never serialize it
						logger.error(`${name} No Response Received`, { code: error.code, message: error.message });
					} else {
						logger.error(`${name} Request Setup Error`, { message: error.message });
					}
					return Promise.reject(error);
				}
			);
		});
	}

	_initCache() {
		this.cache = { users: null, groups: null, collections: null, allowedUnits: null, authorizations: null, members: new Map() };
		this.identities = null;
		this.failures = 0;
	}

	_initConfig() {
		this.ADMIN_EMAIL = (process.env.OUTLINE_ADMIN_EMAIL || 'admin@epfl.ch').toLowerCase();
		this.ADMIN_GROUP = 'ADMINS';
		this.ALLOWED_COLLECTIONS = (process.env.OUTLINE_ALLOWED_COLLECTIONS || 'welcome').split(',').map((s) => s.toLowerCase());
		this.ACCESS_GROUP = process.env.EPFL_ACCESS_GROUP;
		this.SSO_EMAIL_DOMAIN = (process.env.OUTLINE_SSO_EMAIL_DOMAIN || 'epfl.ch').toLowerCase();
		this.FORCE_SUSPEND = process.env.FORCE_SUSPEND === 'true';
		this.MAX_SUSPENSIONS = Number.parseInt(process.env.MAX_SUSPENSIONS || '5', 10);
		if (!Number.isInteger(this.MAX_SUSPENSIONS) || this.MAX_SUSPENSIONS < 0) {
			throw new Error('MAX_SUSPENSIONS must be a non-negative integer');
		}
	}

	/**
	 * Run a read request, retrying on network errors, 429 and 5xx
	 * @param {Function} fn - Request to run
	 * @param {number} attempts - Maximum number of attempts
	 */
	async _retry(fn, attempts = 3) {
		for (let attempt = 1; ; attempt++) {
			try {
				return await fn();
			} catch (err) {
				const status = err.response?.status;
				const retryable = err.isAxiosError && (!status || status === 429 || status >= 500);
				if (!retryable || attempt >= attempts) throw err;
				logger.warn('Request failed, retrying', { attempt, status, message: err.message });
				await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
			}
		}
	}

	/**
	 * Make paginated POST request to Outline API
	 * Outline returns either a plain array (users.list, collections.list) or an object holding
	 * the list under a key next to its raw memberships (groups.list, groups.memberships,
	 * collections.group_memberships), hence the key.
	 * @param {string} endpoint - API endpoint
	 * @param {object} data - Request data
	 * @param {string} key - Key of the list when the response is an object
	 * @returns {Array} - All results
	 */
	async _outlineList(endpoint, data = {}, key = null) {
		const limit = 100;
		const results = [];

		for (let offset = 0; ; offset += limit) {
			const res = await this._retry(() => this.outline.post(endpoint, { ...data, limit, offset }));
			const payload = res.data.data;
			const page = Array.isArray(payload) ? payload : (key && payload?.[key]) || [];
			results.push(...page);
			if (page.length < limit) break;
		}

		return results;
	}

	/**
	 * Run a single write: a failure is logged and counted instead of aborting the whole sync
	 * @param {string} label - What is being done
	 * @param {object} data - Context for the error log
	 * @param {Function} fn - The write
	 * @returns {*} - Result of fn, undefined if it failed
	 */
	async _attempt(label, data, fn) {
		try {
			return await fn();
		} catch (err) {
			this.failures++;
			logger.error(`${label} failed`, { ...data, message: err.message });
			return undefined;
		}
	}

	/**
	 * Get all Outline users (cached), without the technical admin account
	 * @param {boolean} refresh - Force refresh cache
	 * @returns {Array} - Users list
	 */
	async getUsers(refresh = false) {
		if (!this.cache.users || refresh) {
			logger.info('Fetching users from Outline API');
			const all = await this._outlineList('/api/users.list');
			this.cache.users = all.filter((u) => (u.email || '').toLowerCase() !== this.ADMIN_EMAIL);
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
			this.cache.groups = await this._outlineList('/api/groups.list', {}, 'groups');
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
			this.cache.collections = await this._outlineList('/api/collections.list');
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
	 * Get members of an Outline group (fetched once per run, then kept up to date by our own writes)
	 * @param {string} groupId
	 * @returns {Array}
	 */
	async getGroupMembers(groupId) {
		if (!this.cache.members.has(groupId)) {
			logger.info('Fetching group members from Outline', { groupId });
			const members = await this._outlineList('/api/groups.memberships', { id: groupId }, 'users');
			logger.info('Group members fetched', { groupId, count: members.length });
			this.cache.members.set(groupId, new Map(members.map((m) => [m.id, m])));
		}
		return [...this.cache.members.get(groupId).values()];
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
		this.cache.groups?.push(group);
		this.cache.members.set(group.id, new Map());
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
		if (this.cache.groups) this.cache.groups = this.cache.groups.filter((g) => g.id !== id);
		this.cache.members.delete(id);
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
			logger.debug('User already in group', { userId, groupId });
			return false;
		}
		await this.outline.post('/api/groups.add_user', { id: groupId, userId });
		this.cache.members.get(groupId).set(userId, { id: userId });
		return true;
	}

	/**
	 * Remove user from Outline group
	 * @param {string} userId
	 * @param {string} groupId
	 * @returns {boolean} - true if removed, false if not a member
	 */
	async removeUserFromGroup(userId, groupId) {
		const members = await this.getGroupMembers(groupId);
		if (!members.some((m) => m.id === userId)) return false;
		await this.outline.post('/api/groups.remove_user', { id: groupId, userId });
		this.cache.members.get(groupId).delete(userId);
		return true;
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
		this.cache.collections?.push(collection);
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
		if (this.cache.collections) this.cache.collections = this.cache.collections.filter((c) => c.id !== id);
	}

	/**
	 * Add group to collection
	 * @param {string} groupId
	 * @param {string} collectionId
	 * @returns {boolean} - true if linked, false if already linked
	 */
	async addGroupToCollection(groupId, collectionId) {
		const existing = await this._outlineList('/api/collections.group_memberships', { id: collectionId }, 'groups');
		logger.info('Collection group memberships fetched', { collectionId, count: existing.length });
		if (existing.some((g) => g.id === groupId)) return false;
		await this.outline.post('/api/collections.add_group', { id: collectionId, groupId, permission: 'read_write' });
		logger.info('Group linked to collection', { groupId, collectionId });
		return true;
	}

	/**
	 * Set user role
	 * @param {object} user - Outline user (its cached role is updated)
	 * @param {string} role - 'admin' or 'viewer'
	 */
	async setUserRole(user, role) {
		await this.outline.post('/api/users.update_role', { id: user.id, role });
		user.role = role;
		logger.info(role === 'admin' ? 'User promoted to admin' : 'Admin role removed', { email: user.email, userId: user.id });
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
	 * @param {string|number} identifier - Email, username or SCIPER
	 * @returns {object|null}
	 */
	async epflGetPerson(identifier) {
		logger.info('Fetching person from EPFL API', { identifier });
		const res = await this._retry(() => this.epfl.get(`/persons/${encodeURIComponent(identifier)}`, {
			validateStatus: (status) => (status >= 200 && status < 300) || status === 404,
		}));
		if (res.status === 404) {
			logger.info('Person not found in EPFL', { identifier });
			return null;
		}
		logger.info('Person fetched from EPFL', { identifier, sciper: res.data.id });
		return res.data;
	}

	/**
	 * Find the EPFL person behind an Outline account
	 * The Outline e-mail comes from the SSO identity, which is not always the directory e-mail:
	 * an external gets <username>@epfl.ch while the directory holds their own address.
	 * So after the e-mail lookup, the local part is tried as a username.
	 * @param {string} email - Outline e-mail
	 * @returns {object|null} - null only if the person really is unknown
	 */
	async epflFindPersonForEmail(email) {
		const person = await this.epflGetPerson(email);
		if (person) return person;

		const [local, domain] = email.toLowerCase().split('@');
		if (!local || domain !== this.SSO_EMAIL_DOMAIN) return null;

		const byUsername = await this.epflGetPerson(local);
		if (byUsername?.username?.toLowerCase() !== local) return null;

		logger.info('Person matched by username', { email, sciper: byUsername.id });
		return byUsername;
	}

	/**
	 * Get units a person is accredited in
	 * @param {string|number} sciper
	 * @returns {Array}
	 */
	async epflGetUnits(sciper) {
		const res = await this._retry(() => this.epfl.get('/units', { params: { persid: sciper } }));
		const units = res.data.units || [];
		logger.info('User units fetched from EPFL', { sciper, count: units.length });
		return units;
	}

	/**
	 * Get EPFL group members
	 * @param {string} group
	 * @returns {Array}
	 */
	async epflGetGroupMembers(group) {
		logger.info('Fetching group members from EPFL API', { group });
		const res = await this._retry(() => this.epfl.get(`/groups/${group}/members?recursive=1`));
		const members = (res.data.members || []).filter((m) => m.type === 'person');
		logger.info('EPFL group members fetched', { group, count: members.length });
		return members;
	}

	/**
	 * Get sidoc.readwrite authorizations on allowed units from EPFL API (cached)
	 * @returns {Array}
	 */
	async getValidAuthorizations() {
		if (this.cache.authorizations) return this.cache.authorizations;

		logger.info(`Fetching ${AUTHORIZATION_ID} authorizations from EPFL API`);
		const res = await this._retry(() => this.epfl.get('/authorizations', { params: { authid: AUTHORIZATION_ID, type: 'right' } }));
		const auths = res.data.authorizations || [];
		const allowedUnits = await this.getAllowedUnits();

		this.cache.authorizations = auths.filter((a) => {
			const unit = a.reason?.resource?.name;
			return unit && this.isUnitAllowed(unit, allowedUnits);
		});
		logger.info('Authorizations fetched from EPFL', { total: auths.length, valid: this.cache.authorizations.length });
		return this.cache.authorizations;
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
	 * Resolve every Outline user to its EPFL person and accreditations
	 * A user left unresolved because of an API error is never touched by the following steps.
	 */
	async resolveIdentities() {
		const users = await this.getUsers(true);
		const allowedUnits = await this.getAllowedUnits();
		const identities = new Map();
		let consecutiveErrors = 0;

		for (const user of users) {
			if (user.isSuspended) {
				identities.set(user.id, { status: 'suspended' });
				continue;
			}

			try {
				const person = await this.epflFindPersonForEmail(user.email);
				if (!person) {
					identities.set(user.id, { status: 'missing' });
				} else {
					const units = (await this.epflGetUnits(person.id)).filter((u) => this.isUnitAllowed(u.name, allowedUnits));
					identities.set(user.id, { status: 'resolved', sciper: Number(person.id), units });
					logger.info('Retrieved units for user', { email: user.email, sciper: person.id, allowed: units.length });
				}
				consecutiveErrors = 0;
			} catch (err) {
				identities.set(user.id, { status: 'error' });
				this.failures++;
				logger.error('Could not resolve user, leaving untouched', { email: user.email, message: err.message });
				if (++consecutiveErrors >= MAX_CONSECUTIVE_EPFL_ERRORS) {
					throw new Error(`EPFL API unreachable: ${consecutiveErrors} consecutive failures`);
				}
			}
		}

		this.identities = identities;
		const count = (status) => [...identities.values()].filter((i) => i.status === status).length;
		logger.info('Identities resolved', { users: users.length, resolved: count('resolved'), missing: count('missing'), suspended: count('suspended'), errors: count('error') });
	}

	/**
	 * Suspend users that no longer exist at EPFL
	 * Nobody is suspended if there are more than MAX_SUSPENSIONS of them (unless FORCE_SUSPEND),
	 * as that points to a lookup problem rather than to people who actually left.
	 */
	async syncUsers() {
		const users = await this.getUsers();
		const missing = users.filter((u) => this.identities.get(u.id).status === 'missing');
		const stats = { missing: missing.length, suspended: 0, held: 0 };

		if (missing.length > this.MAX_SUSPENSIONS && !this.FORCE_SUSPEND) {
			logger.error('Too many users to suspend, suspending nobody (set FORCE_SUSPEND=true to override)', {
				count: missing.length,
				max: this.MAX_SUSPENSIONS,
				emails: missing.map((u) => u.email),
			});
			this.failures++;
			for (const user of missing) this.identities.get(user.id).status = 'held';
			stats.held = missing.length;
		} else {
			for (const user of missing) {
				logger.warn('User no longer exists in EPFL, suspending', { email: user.email, userId: user.id });
				const done = await this._attempt('Suspend user', { email: user.email }, () => this.suspendUser(user.id, user.email).then(() => true));
				this.identities.get(user.id).status = done ? 'suspended' : 'held';
				if (done) stats.suspended++;
				else stats.held++;
			}
		}

		logger.info('User synchronization completed', stats);
	}

	/**
	 * Sync the EPFL group that grants access to everyone holding the authorization
	 */
	async syncAccessGroup() {
		if (!this.ACCESS_GROUP) return;

		const authorized = new Set((await this.getValidAuthorizations()).map((a) => Number(a.persid)));
		const existing = new Set((await this.epflGetGroupMembers(this.ACCESS_GROUP)).map((m) => Number(m.id)));
		const toAdd = [...authorized].filter((s) => !existing.has(s));
		const toRemove = [...existing].filter((s) => !authorized.has(s));

		logger.info('Syncing EPFL externals group', {
			group: this.ACCESS_GROUP,
			existing: existing.size,
			authorized: authorized.size,
			toAdd: toAdd.length,
			toRemove: toRemove.length,
		});

		if (toAdd.length) await this._attempt('Add users to EPFL group', { group: this.ACCESS_GROUP }, () => this.epflAddToGroup(toAdd, this.ACCESS_GROUP));
		for (const sciper of toRemove) {
			await this._attempt('Remove user from EPFL group', { group: this.ACCESS_GROUP, sciper }, () => this.epflRemoveFromGroup(sciper, this.ACCESS_GROUP));
		}
	}

	/**
	 * Sync unit groups: members are the users accredited in the unit
	 * plus those holding the sidoc.readwrite authorization on it.
	 * Both sources are merged first, then the groups are diffed once.
	 */
	async syncGroups() {
		const users = await this.getUsers();
		const allowedUnits = await this.getAllowedUnits();

		// unit name (lowercase) -> users that must be in the matching group
		const desired = new Map();
		const want = (unitName, userId) => {
			const key = unitName.toLowerCase();
			if (!desired.has(key)) desired.set(key, { name: unitName, userIds: new Set() });
			desired.get(key).userIds.add(userId);
		};

		// users whose memberships are known well enough to be added to *and* removed from groups
		const managed = new Set();
		const userIdsBySciper = new Map();

		for (const user of users) {
			const identity = this.identities.get(user.id);
			if (identity.status === 'suspended') {
				managed.add(user.id);
			} else if (identity.status === 'resolved') {
				managed.add(user.id);
				if (!userIdsBySciper.has(identity.sciper)) userIdsBySciper.set(identity.sciper, []);
				userIdsBySciper.get(identity.sciper).push(user.id);
				for (const unit of identity.units) want(unit.name, user.id);
			}
		}

		// A person who never logged in has no Outline account yet: they join once they do
		const withoutAccount = new Set();
		for (const auth of await this.getValidAuthorizations()) {
			const sciper = Number(auth.persid);
			const userIds = userIdsBySciper.get(sciper);
			if (!userIds) {
				withoutAccount.add(sciper);
				logger.debug('Authorized user not found in Outline', { sciper });
				continue;
			}
			for (const userId of userIds) want(auth.reason.resource.name, userId);
		}

		const stats = { groupsCreated: 0, groupsDeleted: 0, added: 0, removed: 0, authorizedWithoutAccount: withoutAccount.size };
		const usersById = new Map(users.map((u) => [u.id, u]));

		for (const { name, userIds } of desired.values()) {
			let group = await this.findGroup(name);
			if (!group) {
				group = await this._attempt('Create group', { name }, () => this.createGroup(name));
				if (!group) continue;
				stats.groupsCreated++;
			}

			for (const userId of userIds) {
				const added = await this._attempt('Add user to group', { group: name, userId }, () => this.addUserToGroup(userId, group.id));
				if (added) {
					logger.info('User added to group', { email: usersById.get(userId).email, group: name });
					stats.added++;
				}
			}
		}

		for (const group of [...(await this.getGroups())]) {
			const nameLower = group.name.toLowerCase();
			if (nameLower === this.ADMIN_GROUP.toLowerCase()) continue;

			const wanted = desired.get(nameLower)?.userIds;
			const members = await this.getGroupMembers(group.id);

			if (!wanted && members.length === 0) {
				const deleted = await this._attempt('Delete group', { group: group.name }, () => this.deleteGroup(group.id, group.name).then(() => true));
				if (deleted) stats.groupsDeleted++;
				continue;
			}

			// Without a list of allowed units, a group nobody is expected in cannot be told from a hand-made one
			const isUnitGroup = wanted || (allowedUnits !== false && allowedUnits.includes(nameLower));
			if (!isUnitGroup) {
				logger.debug('Group not deleted - has members', { group: group.name, members: members.length });
				continue;
			}

			for (const member of members) {
				if (!managed.has(member.id) || wanted?.has(member.id)) continue;
				const removed = await this._attempt('Remove user from group', { group: group.name, userId: member.id }, () => this.removeUserFromGroup(member.id, group.id));
				if (removed) {
					logger.info('User removed from group', { email: usersById.get(member.id)?.email, group: group.name });
					stats.removed++;
				}
			}
		}

		logger.info('Group synchronization completed', stats);
	}

	/**
	 * Sync admin users
	 */
	async syncAdmins() {
		const users = await this.getUsers();
		const epflAdmins = await this.epflGetGroupMembers(process.env.OUTLINE_ADMIN_GROUP);
		const adminScipers = new Set(epflAdmins.map((a) => Number(a.id)));

		let adminGroup = await this.findGroup(this.ADMIN_GROUP);
		if (!adminGroup) adminGroup = await this.createGroup(this.ADMIN_GROUP);

		logger.info('Starting admin synchronization', { epflAdmins: epflAdmins.length, currentAdmins: users.filter((u) => u.role === 'admin').length });

		const stats = { promoted: 0, demoted: 0, addedToGroup: 0, removedFromGroup: 0 };
		const wanted = new Set();
		const foundScipers = new Set();

		for (const user of users) {
			const identity = this.identities.get(user.id);
			if (identity.status !== 'resolved') continue;
			foundScipers.add(identity.sciper);
			if (adminScipers.has(identity.sciper)) wanted.add(user.id);
		}

		for (const admin of epflAdmins) {
			if (!foundScipers.has(Number(admin.id))) logger.warn('Admin not found in Outline', { sciper: admin.id });
		}

		for (const user of users) {
			if (this.identities.get(user.id).status !== 'resolved') continue;

			if (wanted.has(user.id)) {
				const added = await this._attempt('Add admin to group', { email: user.email }, () => this.addUserToGroup(user.id, adminGroup.id));
				if (added) stats.addedToGroup++;
				if (user.role !== 'admin') {
					const promoted = await this._attempt('Promote admin', { email: user.email }, () => this.setUserRole(user, 'admin').then(() => true));
					if (promoted) stats.promoted++;
				}
			} else if (user.role === 'admin') {
				const demoted = await this._attempt('Demote admin', { email: user.email }, () => this.setUserRole(user, 'viewer').then(() => true));
				if (demoted) stats.demoted++;
			}
		}

		const usersById = new Map(users.map((u) => [u.id, u]));
		for (const member of await this.getGroupMembers(adminGroup.id)) {
			const user = usersById.get(member.id);
			if (!user || wanted.has(user.id) || !['resolved', 'suspended'].includes(this.identities.get(user.id).status)) continue;
			const removed = await this._attempt('Remove user from admin group', { email: user.email }, () => this.removeUserFromGroup(member.id, adminGroup.id));
			if (removed) {
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
		const groups = await this.getGroups();
		const collections = [...(await this.getCollections())];

		logger.info('Starting collection synchronization', { groups: groups.length, collections: collections.length });

		const groupNames = new Set(groups.filter((g) => g.name.toLowerCase() !== this.ADMIN_GROUP.toLowerCase()).map((g) => g.name.toLowerCase()));
		const stats = { created: 0, linked: 0, deleted: 0 };

		for (const group of [...groups]) {
			if (group.name.toLowerCase() === this.ADMIN_GROUP.toLowerCase()) continue;

			let collection = await this.findCollection(group.name);
			if (!collection) {
				collection = await this._attempt('Create collection', { name: group.name }, () => this.createCollection(group.name));
				if (!collection) continue;
				stats.created++;
			}

			const linked = await this._attempt('Link group to collection', { group: group.name }, () => this.addGroupToCollection(group.id, collection.id));
			if (linked) stats.linked++;
		}

		for (const collection of collections) {
			const name = collection.name.toLowerCase();
			if (name === this.ADMIN_GROUP.toLowerCase()) continue;
			if (this.ALLOWED_COLLECTIONS.includes(name)) continue;
			if (groupNames.has(name)) continue;

			const deleted = await this._attempt('Delete collection', { collection: collection.name }, () => this.deleteCollection(collection.id, collection.name).then(() => true));
			if (deleted) stats.deleted++;
		}

		logger.info('Collection synchronization completed', stats);
	}

	/**
	 * Run full synchronization
	 * Steps are independent: one failing does not stop the others, but steps relying on the
	 * resolved identities are skipped if those are not available.
	 * @returns {boolean} - false if anything went wrong
	 */
	async run() {
		logger.info('Starting synchronization', {
			maxSuspensions: this.MAX_SUSPENSIONS,
			forceSuspend: this.FORCE_SUSPEND,
		});

		const failedSteps = [];
		const step = async (name, fn) => {
			logger.info(`Starting step: ${name}`);
			try {
				await fn();
			} catch (error) {
				failedSteps.push(name);
				logger.error(`Step failed: ${name}`, { error: error.message, stack: error.stack });
			}
		};

		await step('resolve identities', () => this.resolveIdentities());
		if (this.identities) await step('users', () => this.syncUsers());
		await step('access group', () => this.syncAccessGroup());
		if (this.identities) {
			await step('groups', () => this.syncGroups());
			await step('admins', () => this.syncAdmins());
		}
		await step('collections', () => this.syncCollections());

		const ok = !failedSteps.length && !this.failures;
		if (ok) {
			logger.info('Complete synchronization process finished successfully');
		} else {
			logger.error('Synchronization finished with errors', { failedSteps, failures: this.failures });
		}
		return ok;
	}
}

async function main() {
	let exitCode = 0;
	try {
		const sync = new OutlineSync();
		if (!(await sync.run())) exitCode = 1;
	} catch (error) {
		exitCode = 1;
		logger.error('Synchronization failed', { error: error.message, stack: error.stack });
	} finally {
		logger.info(`Process exiting with code: ${exitCode}`);
		process.exit(exitCode);
	}
}

main();
