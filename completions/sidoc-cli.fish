# Fish completion for sidoc-cli

# Main commands
complete -c sidoc-cli -f -n "__fish_use_subcommand" -a "user" -d "Manage users (list, add, remove, suspend)"
complete -c sidoc-cli -f -n "__fish_use_subcommand" -a "group" -d "Manage groups (list, create, delete)"
complete -c sidoc-cli -f -n "__fish_use_subcommand" -a "sync" -d "Synchronize data"
complete -c sidoc-cli -f -n "__fish_use_subcommand" -a "backup" -d "Create and manage backups"
complete -c sidoc-cli -f -n "__fish_use_subcommand" -a "status" -d "Show system status"
complete -c sidoc-cli -f -n "__fish_use_subcommand" -a "version" -d "Show version information"
complete -c sidoc-cli -f -n "__fish_use_subcommand" -a "help" -d "Show help message"

# User subcommands
complete -c sidoc-cli -f -n "__fish_seen_subcommand_from user" -a "list" -d "List all users"
complete -c sidoc-cli -f -n "__fish_seen_subcommand_from user" -a "add" -d "Add a new user"
complete -c sidoc-cli -f -n "__fish_seen_subcommand_from user" -a "remove" -d "Remove a user"
complete -c sidoc-cli -f -n "__fish_seen_subcommand_from user" -a "suspend" -d "Suspend a user"
complete -c sidoc-cli -f -n "__fish_seen_subcommand_from user" -a "help" -d "Show help for user command"

# Group subcommands
complete -c sidoc-cli -f -n "__fish_seen_subcommand_from group" -a "list" -d "List all groups"
complete -c sidoc-cli -f -n "__fish_seen_subcommand_from group" -a "create" -d "Create a new group"
complete -c sidoc-cli -f -n "__fish_seen_subcommand_from group" -a "delete" -d "Delete a group"
complete -c sidoc-cli -f -n "__fish_seen_subcommand_from group" -a "help" -d "Show help for group command"

# Sync subcommands
complete -c sidoc-cli -f -n "__fish_seen_subcommand_from sync" -a "start" -d "Start synchronization"
complete -c sidoc-cli -f -n "__fish_seen_subcommand_from sync" -a "status" -d "Show sync status"
complete -c sidoc-cli -f -n "__fish_seen_subcommand_from sync" -a "help" -d "Show help for sync command"

# Backup subcommands
complete -c sidoc-cli -f -n "__fish_seen_subcommand_from backup" -a "create" -d "Create a new backup"
complete -c sidoc-cli -f -n "__fish_seen_subcommand_from backup" -a "list" -d "List available backups"
complete -c sidoc-cli -f -n "__fish_seen_subcommand_from backup" -a "restore" -d "Restore from a backup file"
complete -c sidoc-cli -f -n "__fish_seen_subcommand_from backup" -a "help" -d "Show help for backup command"

# File completion for backup restore
complete -c sidoc-cli -n "__fish_seen_subcommand_from backup; and __fish_seen_subcommand_from restore" -F -a "*.tar.gz"
