const axios = require('axios');
const https = require('https');
const { loadEnvFile } = require('process');

loadEnvFile('./.env');

const agent = new https.Agent({ rejectUnauthorized: false });

const logger = {
	log: (level, message, data = {}) => {
		console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...data }));
	},
	info: (message, data) => logger.log('INFO', message, data),
	error: (message, data) => logger.log('ERROR', message, data),
	warn: (message, data) => logger.log('WARN', message, data),
};

class OutlineSync {
	constructor(baseUrl, apiToken) {
		this.outlineClient = axios.create({
			baseURL: baseUrl,
			headers: {
				Authorization: `Bearer ${apiToken}`,
				'Content-Type': 'application/json',
			},
			httpsAgent: agent,
			timeout: 10000,
		});

		this.epflClient = axios.create({
			baseURL: process.env.EPFL_API_URL,
			headers: {
				Authorization: 'Basic ' + btoa(process.env.EPFL_API_USERNAME + ':' + process.env.EPFL_API_PASSWORD),
			},
		});

		this.addInterceptors(this.outlineClient);
		this.addInterceptors(this.epflClient);
	}

	addInterceptors(client) {
		client.interceptors.request.use(
			(config) => {
				logger.info('API Request', {
					method: config.method,
					url: config.url,
				});
				return config;
			},
			(error) => {
				logger.error('API Request Error', {
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
					logger.error('API Response Error', {
						status: error.response.status,
						data: error.response.data,
						headers: error.response.headers,
					});
				} else if (error.request) {
					logger.error('No Response Received', {
						request: error.request,
					});
				} else {
					logger.error('Request Setup Error', {
						message: error.message,
					});
				}
				return Promise.reject(error);
			}
		);
	}

	async getUserUnits(email) {
		try {
			const personResponse = await this.epflClient.get(`/person/${email}`);
			console.log('Person response:', personResponse.data);
			const sciper = personResponse.data?.sciper;

			if (!sciper) {
				logger.warn(`No SCIPER found for email: ${email}`);
				return [];
			}

			const units = await this.epflClient.get(`/units?persid=${sciper}`);
			console.log('Units response:', units.data);

			logger.info('Units retrieved successfully', {
				email,
				totalUnits: unitsResponse.data.length,
			});
			return unitsResponse.data;
		} catch (error) {
			logger.error('Failed to retrieve user units', {
				email,
				errorMessage: error.message,
			});
			return [];
		}
	}

	async getAllUsers() {
		try {
			const response = await this.outlineClient.post('/api/users.list');
			return response.data.data.filter((user) => user.lastActiveAt);
		} catch (error) {
			logger.error('Failed to retrieve users', { errorMessage: error.message });
			return [];
		}
	}

	async getAllGroups() {
		try {
			const response = await this.outlineClient.post('/api/groups.list');
			return response.data.data.groups;
		} catch (error) {
			logger.error('Failed to retrieve groups', { errorMessage: error.message });
			return [];
		}
	}

	async findUserByEmail(email) {
		const users = await this.getAllUsers();
		return users.find((u) => u.email === email) || null;
	}

	async findExistingGroup(name) {
		const groups = await this.getAllGroups();
		return groups.find((g) => g.name.toLowerCase() === name.toLowerCase()) || null;
	}

	async findExistingCollection(name) {
		try {
			const response = await this.outlineClient.post('/api/collections.list', { limit: 100 });
			return response.data.data.find((collection) => collection.name.toLowerCase() === name.toLowerCase()) || null;
		} catch (error) {
			logger.error('Failed to search for collection', { collectionName: name, errorMessage: error.message });
			return null;
		}
	}

	async createGroup(name) {
		try {
			logger.info('Creating group', { groupName: name });
			const response = await this.outlineClient.post('/api/groups.create', { name });
			return response.data.data;
		} catch (error) {
			logger.error('Failed to create group', { groupName: name, errorMessage: error.message });
			return null;
		}
	}

	async createCollection(name, groupId) {
		try {
			const response = await this.outlineClient.post('/api/collections.create', {
				name,
				permission: 'read',
				private: true,
			});
			await this.outlineClient.post('/api/collections.add_group', { id: response.data.data.id, groupId, permission: 'read_write' });
			return response.data.data;
		} catch (error) {
			logger.error('Failed to create collection', { collectionName: name, errorMessage: error.message });
			return null;
		}
	}

	async addUserToGroup(userId, groupId) {
		try {
			await this.outlineClient.post('/api/groups.add_user', { id: groupId, userId });
			logger.info('User added to group', { groupId, userId });
		} catch (error) {
			logger.error('Failed to add user to group', { groupId, userId, errorMessage: error.message });
		}
	}

	async removeUserFromGroup(userId, groupId) {
		try {
			await this.outlineClient.post('/api/groups.remove_user', { id: groupId, userId });
			logger.info('User removed from group', { groupId, userId });
		} catch (error) {
			logger.error('Failed to remove user from group', { groupId, userId, errorMessage: error.message });
		}
	}

	async syncUsers() {
		try {
			const activeUsers = await this.getAllUsers();
			const existingGroups = await this.getAllGroups();

			const userUnitsMap = {};
			for (const user of activeUsers) {
				userUnitsMap[user.email] = await this.getUserUnits(user.email);
			}

			for (const user of activeUsers) {
				const unitsForUser = userUnitsMap[user.email] || [];

				for (const unit of unitsForUser) {
					let group = await this.findExistingGroup(unit.name);
					if (!group) {
						group = await this.createGroup(unit.name);
					}
					if (group) {
						await this.addUserToGroup(user.id, group.id);
						let collection = await this.findExistingCollection(unit.name);
						if (!collection) {
							collection = await this.createCollection(unit.name, group.id);
						}
					}
				}
			}

			for (const group of existingGroups) {
				const unit = Object.values(userUnitsMap)
					.flat()
					.find((u) => u.name.toLowerCase() === group.name.toLowerCase());

				if (unit) {
					const groupMembersResponse = await this.outlineClient.post('/api/groups.memberships', { id: group.id, limit: 100 });
					const groupMembers = groupMembersResponse.data.data.users;
					const users = await this.getAllUsers();

					for (const member of groupMembers) {
						const user = users.find((user) => user.id == member.id);
						const memberUnits = userUnitsMap[user.email] || [];

						if (!memberUnits.some((u) => u.name.toLowerCase() === group.name.toLowerCase())) {
							await this.removeUserFromGroup(member.id, group.id);
						}
					}
				}
			}

			logger.info('Synchronization completed');
		} catch (error) {
			logger.error('Error during synchronization', { errorMessage: error.message, stack: error.stack });
		}
	}
}

async function main() {
	try {
		const outlineSync = new OutlineSync(process.env.OUTLINE_BASE_URL, process.env.OUTLINE_API_TOKEN);
		await outlineSync.syncUsers();
		process.exit(0);
	} catch (error) {
		logger.error('Synchronization failed', { errorMessage: error.message, stack: error.stack });
		process.exit(1);
	}
}

main();
