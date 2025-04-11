import pkg from 'pg';
import crypto from 'crypto';
import * as k8s from '@kubernetes/client-node';
import dotenv from 'dotenv';

dotenv.config();

const { Client } = pkg;

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

class ApiKeySetup {
	constructor() {
		// Initialize Kubernetes client
		this.kc = new k8s.KubeConfig();
		this.kc.loadFromDefault();
		this.k8sApi = this.kc.makeApiClient(k8s.CoreV1Api);

		// Get database configuration from environment variables
		this.dbHost = process.env.DB_HOST || 'localhost';
		this.dbPort = process.env.DB_PORT || 5432;
		this.dbName = process.env.DB_NAME || 'outlinewiki-db';
		this.dbUser = process.env.DB_USER || 'outlinewiki-user';
		this.dbPassword = process.env.DB_PASSWORD;

		// Admin configuration
		this.adminEmail = process.env.OUTLINE_ADMIN_EMAIL || 'admin@epfl.ch';
		this.adminName = process.env.OUTLINE_ADMIN_NAME || 'EPFL Admin';

		// API Keys configuration
		this.defaultKeyExpiration = process.env.API_KEY_EXPIRATION || '2029-06-30T21:59:59.999Z';

		// Admin API key config
		this.adminSecretName = process.env.ADMIN_SECRET_NAME || 'outlinewiki-api-key-admin';
		this.adminKeyName = 'admin-api-key';

		// Monitoring API key config
		this.monitoringSecretName = process.env.MONITORING_SECRET_NAME || 'outlinewiki-api-key-monitoring';
		this.monitoringKeyName = 'monitoring-api-key';

		// Auto-detect namespace or use provided value
		this.detectNamespace();

		logger.info('Initialized with configuration', {
			dbHost: this.dbHost,
			dbName: this.dbName,
			adminSecretName: this.adminSecretName,
			monitoringSecretName: this.monitoringSecretName,
			adminEmail: this.adminEmail,
		});

		if (!this.dbPassword) {
			throw new Error('Missing required database password');
		}
	}

	/**
	 * Generate a random string of specified length
	 * @param {number} length - Length of the random string
	 * @returns {string} Random string
	 */
	generateRandomString(length) {
		const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		let result = '';
		for (let i = 0; i < length; i++) {
			result += characters.charAt(Math.floor(Math.random() * characters.length));
		}
		return result;
	}

	/**
	 * Detect current Kubernetes namespace
	 * @returns {String} Current namespace
	 */
	async detectNamespace() {
		try {
			const namespace = this.kc.getContextObject(this.kc.currentContext)?.namespace;
			if (namespace) {
				logger.info('Detected Kubernetes namespace from context', { namespace });
				this.namespace = namespace;
				return;
			}

			const serviceAccountNamespace = await this.k8sApi.readNamespacedServiceAccount('default', 'default');

			if (serviceAccountNamespace?.body?.metadata?.namespace) {
				logger.info('Detected Kubernetes namespace from service account', { namespace: serviceAccountNamespace.body.metadata.namespace });
				this.namespace = serviceAccountNamespace.body.metadata.namespace;
				return;
			}
		} catch (error) {
			logger.warn('Failed to auto-detect namespace', { error: error.message });
		}

		this.namespace = process.env.K8S_NAMESPACE || 'default';
		logger.info('Using namespace from environment or default', { namespace: this.namespace });
	}

	/**
	 * Connect to the database and create client
	 * @returns {Client} PostgreSQL client
	 */
	async connectToDatabase() {
		// Create a new PostgreSQL client
		const client = new Client({
			host: this.dbHost,
			port: this.dbPort,
			database: this.dbName,
			user: this.dbUser,
			password: this.dbPassword,
		});

		try {
			// Connect to the database
			await client.connect();
			logger.info('Connected to Outline database');
			return client;
		} catch (error) {
			logger.error('Database connection error', {
				message: error.message,
				stack: error.stack,
			});
			throw error;
		}
	}

	/**
	 * Get team ID for the admin user
	 * @param {Client} client - Database client
	 * @returns {String} Team ID
	 */
	async getTeamId(client) {
		const teamDomain = this.adminEmail.split('@')[1];

		// Try to find team by domain from admin email
		const teamQuery = `
			SELECT id FROM teams
			WHERE domain = $1 OR name = $1
			LIMIT 1
		`;

		const team = await client.query(teamQuery, [teamDomain]);

		if (team.rows.length === 0) {
			// If no team with matching domain, get the first team
			logger.warn(`Team with domain ${teamDomain} not found, trying to use the first team`);
			const firstTeamQuery = `SELECT id FROM teams LIMIT 1`;
			const firstTeam = await client.query(firstTeamQuery);

			if (firstTeam.rows.length === 0) {
				logger.error('No teams found in the database, cannot create admin user');
				throw new Error('No teams found in the database, cannot create admin user');
			}

			logger.info('Using first available team', { teamId: firstTeam.rows[0].id });
			return firstTeam.rows[0].id;
		}

		logger.info('Found team for admin', { teamId: team.rows[0].id, domain: teamDomain });
		return team.rows[0].id;
	}

	/**
	 * Find existing K8s secret and extract API key if it exists
	 * @param {String} secretName - Name of the secret to check
	 * @returns {String|null} Existing API key or null
	 */
	async getExistingSecretApiKey(secretName) {
		try {
			const secret = await this.k8sApi.readNamespacedSecret({ name: secretName, namespace: this.namespace });
			if (secret?.data?.API_KEY) {
				const apiKey = Buffer.from(secret.data.API_KEY, 'base64').toString();
				logger.info('Found existing API key in Kubernetes secret', { secretName });
				return apiKey;
			}
		} catch (error) {
			if (error.response?.statusCode !== 404) {
				logger.warn('Error checking existing Kubernetes secret', {
					error: error.message,
					statusCode: error.response?.statusCode,
					secretName,
				});
			} else {
				logger.info('No existing Kubernetes secret found', { secretName });
			}
		}
		return null;
	}

	/**
	 * Validate an existing API key against the database
	 * @param {Client} client - Database client
	 * @param {String} apiKey - API key to validate
	 * @returns {Object|null} User ID and API key ID if valid, null otherwise
	 */
	async validateExistingApiKey(client, apiKey) {
		if (!apiKey) return null;

		try {
			// Extract the last 4 characters of the API key
			const last4 = apiKey.slice(-4);

			// Hash the API key
			const hash = crypto.createHash('sha256').update(apiKey).digest('hex');

			// Look up the API key in the database
			const query = `
				SELECT ak.id as "apiKeyId", ak."userId", ak.name, u.email, u.role, u.flags
				FROM "apiKeys" ak
				JOIN users u ON ak."userId" = u.id
				WHERE ak.hash = $1 AND ak.last4 = $2
			`;

			const result = await client.query(query, [hash, last4]);

			if (result.rows.length > 0) {
				const user = result.rows[0];
				const isSuper = user.flags?.super === true;

				logger.info('Validated existing API key', {
					apiKeyId: user.apiKeyId,
					apiKeyName: user.name,
					userId: user.userId,
					email: user.email,
					role: user.role,
					isSuper,
				});

				return {
					userId: user.userId,
					apiKeyId: user.apiKeyId,
					apiKeyName: user.name,
					email: user.email,
					isSuper,
				};
			}
		} catch (error) {
			logger.warn('Error validating existing API key', { error: error.message });
		}

		logger.info('Existing API key is invalid or not found in database');
		return null;
	}

	/**
	 * Handle multiple super admin users
	 * @param {Client} client - Database client
	 * @returns {String} Admin user ID that should be kept
	 */
	async handleMultipleAdmins(client) {
		// Find all super admin users
		const findAllAdminsQuery = `
			SELECT id, email, "createdAt" 
			FROM users 
			WHERE flags @> '{"super": true}'
			ORDER BY "createdAt" ASC
		`;

		const allAdmins = await client.query(findAllAdminsQuery);

		// If there's only one admin, return it
		if (allAdmins.rows.length <= 1) {
			return allAdmins.rows[0]?.id;
		}

		logger.warn('Multiple super admin users found', { count: allAdmins.rows.length });

		// Try to find admin that matches the configured email
		const matchingAdmin = allAdmins.rows.find((admin) => admin.email === this.adminEmail);

		// Choose which admin to keep
		let adminToKeep;
		if (matchingAdmin) {
			// Keep the admin that matches the configured email
			adminToKeep = matchingAdmin;
			logger.info('Keeping admin with matching email', {
				email: adminToKeep.email,
				id: adminToKeep.id,
			});
		} else {
			// Keep the oldest admin (first created)
			adminToKeep = allAdmins.rows[0];
			logger.info('Keeping oldest admin user', {
				email: adminToKeep.email,
				id: adminToKeep.id,
				createdAt: adminToKeep.createdAt,
			});
		}

		// Get IDs of admins to demote
		const adminsToRemove = allAdmins.rows.filter((admin) => admin.id !== adminToKeep.id).map((admin) => admin.id);

		if (adminsToRemove.length > 0) {
			logger.info('Removing super privileges from other admins', {
				count: adminsToRemove.length,
				adminIds: adminsToRemove,
			});

			// Update other admin users to remove super privileges
			const updateQuery = `
				UPDATE users
				SET flags = flags - 'super',
					role = 'member'
				WHERE id = ANY($1::uuid[])
			`;

			await client.query(updateQuery, [adminsToRemove]);

			// Revoke all API keys from demoted admins
			await this.revokeApiKeys(client, adminsToRemove);
		}

		return adminToKeep.id;
	}

	/**
	 * Revoke all API keys for specified users
	 * @param {Client} client - Database client
	 * @param {Array} userIds - Array of user IDs
	 */
	async revokeApiKeys(client, userIds) {
		if (!userIds || userIds.length === 0) return;

		try {
			// Find all API keys for these users
			const findKeysQuery = `
				SELECT id, "userId", name
				FROM "apiKeys"
				WHERE "userId" = ANY($1::uuid[])
			`;

			const keys = await client.query(findKeysQuery, [userIds]);

			if (keys.rows.length > 0) {
				logger.info('Revoking API keys', { count: keys.rows.length });

				// Delete the API keys
				const deleteKeysQuery = `
					DELETE FROM "apiKeys"
					WHERE id = ANY($1::uuid[])
				`;

				const keyIds = keys.rows.map((key) => key.id);
				await client.query(deleteKeysQuery, [keyIds]);

				logger.info('API keys successfully revoked', { keyIds });
			} else {
				logger.info('No API keys found for users', { userIds });
			}
		} catch (error) {
			logger.error('Failed to revoke API keys', {
				error: error.message,
				userIds,
			});
		}
	}

	/**
	 * Create or find admin user
	 * @param {Client} client - Database client
	 * @returns {String} Admin user ID
	 */
	async createOrFindAdmin(client) {
		// Check if super admin users exist
		const checkAdminQuery = `
			SELECT id FROM users 
			WHERE flags @> '{"super": true}'
		`;

		const adminCheckResult = await client.query(checkAdminQuery);
		let adminId;

		if (adminCheckResult.rows.length > 1) {
			// Multiple super admins found, handle this situation
			adminId = await this.handleMultipleAdmins(client);

			// Update admin details if needed
			await this.updateAdminUser(client, adminId);

			return adminId;
		} else if (adminCheckResult.rows.length === 1) {
			// Single admin found, use this one
			adminId = adminCheckResult.rows[0].id;

			// Update admin details if needed
			await this.updateAdminUser(client, adminId);

			logger.info('Found existing admin user', { adminId });
			return adminId;
		} else {
			// No admin user exists, create new one
			return await this.createNewAdminUser(client);
		}
	}

	/**
	 * Update admin user details if they don't match expected values
	 * @param {Client} client - Database client
	 * @param {String} adminId - Admin user ID
	 */
	async updateAdminUser(client, adminId) {
		// Get current admin details
		const adminQuery = `
			SELECT email, name, role
			FROM users
			WHERE id = $1
		`;

		const adminResult = await client.query(adminQuery, [adminId]);
		const admin = adminResult.rows[0];

		// Check if we need to update
		if (admin.email !== this.adminEmail || admin.name !== this.adminName || admin.role !== 'admin') {
			logger.info('Updating admin user details', {
				currentEmail: admin.email,
				newEmail: this.adminEmail,
				currentName: admin.name,
				newName: this.adminName,
				currentRole: admin.role,
			});

			// Update admin details
			const updateQuery = `
				UPDATE users
				SET email = $1,
					name = $2,
					role = 'admin',
					flags = flags || '{"super": true}'::jsonb
				WHERE id = $3
			`;

			await client.query(updateQuery, [this.adminEmail, this.adminName, adminId]);

			logger.info('Admin user details updated successfully');
		}
	}

	/**
	 * Create a new admin user
	 * @param {Client} client - Database client
	 * @returns {String} Admin user ID
	 */
	async createNewAdminUser(client) {
		logger.info('No admin user found, creating new admin user');

		const userId = crypto.randomUUID();
		const createdAt = new Date().toISOString();
		const teamId = await this.getTeamId(client);

		const createAdminQuery = `
			INSERT INTO users ("id", "email", "name", "role", "teamId", "flags", "createdAt", "updatedAt")
			VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
			RETURNING id
		`;

		const createResult = await client.query(createAdminQuery, [userId, this.adminEmail, this.adminName, 'admin', teamId, '{"super": true}', createdAt]);

		const adminId = createResult.rows[0].id;
		logger.info('Created new admin user', { adminId, email: this.adminEmail });

		return adminId;
	}

	/**
	 * Check and manage existing API key
	 * @param {Client} client - Database client
	 * @param {String} userId - User ID
	 * @param {String} keyName - Name of the API key
	 * @param {String} secretName - Name of the Kubernetes secret
	 * @returns {Object} API key status info
	 */
	async manageExistingApiKey(client, userId, keyName, secretName) {
		// Get existing API key from K8s secret
		const existingSecretApiKey = await this.getExistingSecretApiKey(secretName);

		// If there's a key in the secret, validate it
		if (existingSecretApiKey) {
			const validatedKey = await this.validateExistingApiKey(client, existingSecretApiKey);

			if (validatedKey) {
				// If the key belongs to our user and has the correct name
				if (validatedKey.userId === userId && validatedKey.apiKeyName === keyName) {
					logger.info('Existing API key is valid and belongs to correct user', { keyName });
					return {
						valid: true,
						existingKey: existingSecretApiKey,
						apiKeyId: validatedKey.apiKeyId,
					};
				} else {
					// Key belongs to another user or has wrong name
					logger.warn('API key in secret is invalid for this purpose', {
						keyUserId: validatedKey.userId,
						expectedUserId: userId,
						keyName: validatedKey.apiKeyName,
						expectedKeyName: keyName,
					});
				}
			}
		}

		// Check if user has any existing API keys with the expected name
		const existingApiKeyQuery = `
            SELECT id FROM "apiKeys" 
            WHERE "userId" = $1 AND name = $2 
            LIMIT 1
        `;

		const existingKeyResult = await client.query(existingApiKeyQuery, [userId, keyName]);

		if (existingKeyResult.rows.length > 0) {
			// User has an existing key but it doesn't match the secret, revoke it
			logger.info(`User has existing API key with name '${keyName}' but it doesn't match the K8s secret, revoking it`);
			await client.query(`DELETE FROM "apiKeys" WHERE id = $1`, [existingKeyResult.rows[0].id]);
		}

		return { valid: false };
	}

	/**
	 * Generate and store API key
	 * @param {Client} client - Database client
	 * @param {String} userId - User ID
	 * @param {String} keyName - Name of the API key
	 * @returns {String} Generated API key
	 */
	async createApiKey(client, userId, keyName) {
		// Generate a secure random token with the correct prefix
		const prefix = 'ol_api_';
		const secret = `${prefix}${this.generateRandomString(38)}`;
		const apiKeyId = crypto.randomUUID();
		const createdAt = new Date().toISOString();
		const expiresAt = new Date(this.defaultKeyExpiration);

		// Hash the API key using SHA-256
		const hash = crypto.createHash('sha256').update(secret).digest('hex');
		const last4 = secret.slice(-4);

		// Insert the new API key - using parameterized query for security
		const insertApiKeyQuery = `
			INSERT INTO "apiKeys" ("id", "name", "hash", "last4", "userId", "createdAt", "updatedAt", "expiresAt") 
			VALUES ($1, $2, $3, $4, $5, $6, $6, $7)
		`;

		await client.query(insertApiKeyQuery, [apiKeyId, keyName, hash, last4, userId, createdAt, expiresAt]);

		logger.info('Created new API token', { apiKeyId, keyName });
		return secret;
	}

	/**
	 * Store API key in Kubernetes secret
	 * @param {String} apiKey - The API key to store
	 * @param {String} secretName - Name of the Kubernetes secret
	 * @returns {Boolean} Success status
	 */
	async storeInKubernetesSecret(apiKey, secretName) {
		try {
			// Create secret data with base64 encoded API key
			const secretData = {
				API_KEY: Buffer.from(apiKey).toString('base64'),
			};

			// Try to create a new secret
			try {
				await this.k8sApi.createNamespacedSecret({
					namespace: this.namespace,
					body: {
						apiVersion: 'v1',
						kind: 'Secret',
						metadata: {
							name: secretName,
							namespace: this.namespace,
						},
						data: secretData,
						type: 'Opaque',
					},
				});
				logger.info('Kubernetes secret created successfully', {
					secretName: secretName,
					namespace: this.namespace,
				});
			} catch (error) {
				// If secret already exists (409 Conflict), update it
				if (error.body && JSON.parse(error.body).code === 409) {
					logger.info('Secret already exists, updating', {
						secretName: secretName,
					});

					await this.k8sApi.replaceNamespacedSecret({
						namespace: this.namespace,
						name: secretName,
						body: {
							apiVersion: 'v1',
							kind: 'Secret',
							metadata: {
								name: secretName,
								namespace: this.namespace,
							},
							data: secretData,
							type: 'Opaque',
						},
					});
					logger.info('Kubernetes secret updated successfully', { secretName });
				} else {
					throw error;
				}
			}
			return true;
		} catch (error) {
			logger.error('Error storing API key in Kubernetes', {
				error: error.message,
				stack: error.stack,
				secretName: secretName,
				namespace: this.namespace,
			});
			return false;
		}
	}

	/**
	 * Setup API key for a specific purpose
	 * @param {Client} client - Database client
	 * @param {String} userId - User ID
	 * @param {String} keyName - Name of the API key
	 * @param {String} secretName - Name of the Kubernetes secret
	 * @returns {Object} Result of the operation
	 */
	async setupApiKey(client, userId, keyName, secretName) {
		try {
			const keyStatus = await this.manageExistingApiKey(client, userId, keyName, secretName);

			let apiKey;

			if (keyStatus.valid && keyStatus.existingKey) {
				// Use existing key
				apiKey = keyStatus.existingKey;
				logger.info(`Using existing valid ${keyName}`);
			} else {
				// Create new API key
				apiKey = await this.createApiKey(client, userId, keyName);
				logger.info(`New ${keyName} created`);
			}

			// Store API key in Kubernetes secret
			const secretStored = await this.storeInKubernetesSecret(apiKey, secretName);

			if (!secretStored) {
				return {
					success: false,
					message: `Failed to store ${keyName} in Kubernetes secret`,
				};
			}

			return {
				success: true,
				message: `${keyName} setup completed successfully`,
			};
		} catch (error) {
			logger.error(`${keyName} setup failed`, {
				error: error.message,
				stack: error.stack,
			});

			return {
				success: false,
				error: error.message,
			};
		}
	}

	/**
	 * Main process to create admin user and setup API keys
	 * @returns {Object} Result of the operation
	 */
	async setup() {
		let client;
		try {
			client = await this.connectToDatabase();

			await client.query('BEGIN');

			// Find or create admin user
			const adminId = await this.createOrFindAdmin(client);

			// Setup admin API key
			const adminKeyResult = await this.setupApiKey(client, adminId, this.adminKeyName, this.adminSecretName);

			// Setup monitoring API key (read-only)
			const monitoringKeyResult = await this.setupApiKey(client, adminId, this.monitoringKeyName, this.monitoringSecretName);

			// Commit the transaction
			await client.query('COMMIT');

			if (!adminKeyResult.success) {
				return {
					success: false,
					message: adminKeyResult.message || adminKeyResult.error,
				};
			}

			if (!monitoringKeyResult.success) {
				return {
					success: false,
					message: monitoringKeyResult.message || monitoringKeyResult.error,
				};
			}

			return {
				success: true,
				message: 'Admin user, admin API key, and monitoring API key setup completed successfully',
			};
		} catch (error) {
			// Rollback transaction in case of error
			if (client) {
				try {
					await client.query('ROLLBACK');
					logger.info('Transaction rolled back due to error');
				} catch (rollbackError) {
					logger.error('Failed to rollback transaction', {
						error: rollbackError.message,
					});
				}
			}

			logger.error('Setup failed', {
				error: error.message,
				stack: error.stack,
			});

			return {
				success: false,
				error: error.message,
			};
		} finally {
			// Close database connection
			if (client) {
				await client.end();
				logger.info('Database connection closed');
			}
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
		const requiredEnvVars = ['DB_PASSWORD'];
		const missingVars = requiredEnvVars.filter((varName) => !process.env[varName]);

		if (missingVars.length > 0) {
			throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
		}

		// Initialize and run the setup
		const apiKeySetup = new ApiKeySetup();
		const result = await apiKeySetup.setup();

		if (!result.success) {
			// Complete failure
			exitCode = 1;
			logger.error('Setup failed', {
				reason: result.error || result.message || 'Unknown error',
			});
		} else {
			// Full success
			logger.info('Setup process completed successfully', {
				message: result.message,
			});
		}
	} catch (error) {
		// Unexpected error
		exitCode = 1;
		logger.error('Setup failed with unexpected error', {
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
