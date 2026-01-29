# sidoc.ops

Ansible deployment for **Sidoc** based on [Outline](https://www.getoutline.com/)

## Components

- **Outline** - Web app, collaboration service, sync CronJob
- **PostgreSQL** - CloudNativePG with S3 backups
- **Redis** - Cache and sessions
- **Monitoring** - Prometheus, Alertmanager, Telegram alerts

## Prerequisites

- Access to OpenShift cluster
- Keybase secrets (`/keybase/team/epfl_sidoc/secrets.yml`)

## Deployment

```bash
./sidocsible --test
./sidocsible --prod
```

### With tags

```bash
./sidocsible --prod --tags outline
./sidocsible --prod --tags postgres
./sidocsible --prod --tags redis
./sidocsible --prod --tags monitoring
```

## Configuration

Variables are defined in `group_vars/`:
- `all.yml` - Common settings
- `prod.yml` / `test.yml` - Environment-specific resources
