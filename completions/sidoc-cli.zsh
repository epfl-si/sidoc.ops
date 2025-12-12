#compdef sidoc-cli
# Zsh completion for sidoc-cli

_sidoc_cli() {
    local -a commands
    commands=(
        'user:Manage users (list, add, remove, suspend)'
        'group:Manage groups (list, create, delete)'
        'sync:Synchronize data'
        'backup:Create and manage backups'
        'status:Show system status'
        'version:Show version information'
        'help:Show help message'
    )

    local -a user_subcommands
    user_subcommands=(
        'list:List all users'
        'add:Add a new user'
        'remove:Remove a user'
        'suspend:Suspend a user'
        'help:Show help for user command'
    )

    local -a group_subcommands
    group_subcommands=(
        'list:List all groups'
        'create:Create a new group'
        'delete:Delete a group'
        'help:Show help for group command'
    )

    local -a sync_subcommands
    sync_subcommands=(
        'start:Start synchronization'
        'status:Show sync status'
        'help:Show help for sync command'
    )

    local -a backup_subcommands
    backup_subcommands=(
        'create:Create a new backup'
        'list:List available backups'
        'restore:Restore from a backup file'
        'help:Show help for backup command'
    )

    local curcontext="$curcontext" state line
    typeset -A opt_args

    _arguments -C \
        '1: :->command' \
        '2: :->subcommand' \
        '3: :->argument' \
        && return 0

    case $state in
        command)
            _describe 'command' commands
            ;;
        subcommand)
            case $line[1] in
                user)
                    _describe 'user subcommand' user_subcommands
                    ;;
                group)
                    _describe 'group subcommand' group_subcommands
                    ;;
                sync)
                    _describe 'sync subcommand' sync_subcommands
                    ;;
                backup)
                    _describe 'backup subcommand' backup_subcommands
                    ;;
            esac
            ;;
        argument)
            case $line[1] in
                user)
                    case $line[2] in
                        add|remove|suspend)
                            _message 'email address'
                            ;;
                    esac
                    ;;
                group)
                    case $line[2] in
                        create|delete)
                            _message 'group name'
                            ;;
                    esac
                    ;;
                backup)
                    case $line[2] in
                        restore)
                            _files -g '*.tar.gz'
                            ;;
                    esac
                    ;;
            esac
            ;;
    esac

    return 0
}

_sidoc_cli "$@"
