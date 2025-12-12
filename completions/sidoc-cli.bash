#!/usr/bin/env bash
# Bash completion for sidoc-cli

_sidoc_cli() {
    local cur prev words cword
    _init_completion || return

    local commands="user group sync backup status version help"
    local user_subcommands="list add remove suspend help"
    local group_subcommands="list create delete help"
    local sync_subcommands="start status help"
    local backup_subcommands="create list restore help"

    # Complete first argument (main command)
    if [[ $cword -eq 1 ]]; then
        COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
        return
    fi

    # Complete subcommands based on main command
    case "${words[1]}" in
        user)
            if [[ $cword -eq 2 ]]; then
                COMPREPLY=( $(compgen -W "$user_subcommands" -- "$cur") )
            elif [[ $cword -eq 3 ]]; then
                case "${words[2]}" in
                    add|remove|suspend)
                        # Could add email completion here if needed
                        COMPREPLY=()
                        ;;
                esac
            fi
            ;;
        group)
            if [[ $cword -eq 2 ]]; then
                COMPREPLY=( $(compgen -W "$group_subcommands" -- "$cur") )
            elif [[ $cword -eq 3 ]]; then
                case "${words[2]}" in
                    create|delete)
                        # Could add group name completion here if needed
                        COMPREPLY=()
                        ;;
                esac
            fi
            ;;
        sync)
            if [[ $cword -eq 2 ]]; then
                COMPREPLY=( $(compgen -W "$sync_subcommands" -- "$cur") )
            fi
            ;;
        backup)
            if [[ $cword -eq 2 ]]; then
                COMPREPLY=( $(compgen -W "$backup_subcommands" -- "$cur") )
            elif [[ $cword -eq 3 ]]; then
                case "${words[2]}" in
                    restore)
                        # Complete with .tar.gz files
                        COMPREPLY=( $(compgen -f -X '!*.tar.gz' -- "$cur") )
                        ;;
                esac
            fi
            ;;
        status|version|help)
            # No subcommands
            COMPREPLY=()
            ;;
    esac
}

complete -F _sidoc_cli sidoc-cli
