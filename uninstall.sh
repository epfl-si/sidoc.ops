#!/bin/bash
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"
CLI_NAME="sidoc-cli"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

CHECK="${GREEN}✓${RESET}"
CROSS="${RED}✗${RESET}"
ARROW="${BLUE}→${RESET}"
INFO="${CYAN}ℹ${RESET}"
WARN="${YELLOW}⚠${RESET}"

print_header() {
    echo -e "\n${BOLD}${MAGENTA}╔════════════════════════════════════╗${RESET}"
    echo -e "${BOLD}${MAGENTA}║${RESET}       ${BOLD}SIDOC CLI Uninstaller${RESET}        ${BOLD}${MAGENTA}║${RESET}"
    echo -e "${BOLD}${MAGENTA}╚════════════════════════════════════╝${RESET}\n"
}

print_step() {
    echo -e "${ARROW} ${BOLD}$1${RESET}"
}

print_success() {
    echo -e "  ${CHECK} $1"
}

print_error() {
    echo -e "  ${CROSS} $1" >&2
    exit 1
}

print_info() {
    echo -e "  ${INFO} ${DIM}$1${RESET}"
}

print_warn() {
    echo -e "  ${WARN} $1"
}

uninstall_cli() {
    local cli_path="${INSTALL_DIR}/${CLI_NAME}"

    if [[ ! -e "$cli_path" ]]; then
        print_warn "CLI not found at $cli_path"
        return 1
    fi

    print_step "Removing sidoc-cli from ${INSTALL_DIR}"

    if [[ -w "$INSTALL_DIR" ]]; then
        rm -f "$cli_path"
    else
        print_info "Need sudo to remove from ${INSTALL_DIR}"
        sudo rm -f "$cli_path"
    fi

    print_success "sidoc-cli removed from ${INSTALL_DIR}"
    echo
}

uninstall_bash_completion() {
    local completion_dirs=(
        "/etc/bash_completion.d/${CLI_NAME}"
        "/usr/local/etc/bash_completion.d/${CLI_NAME}"
        "/usr/share/bash-completion/completions/${CLI_NAME}"
        "$HOME/.local/share/bash-completion/completions/${CLI_NAME}"
    )

    local found=false
    for completion_file in "${completion_dirs[@]}"; do
        if [[ -f "$completion_file" ]]; then
            found=true
            local dir=$(dirname "$completion_file")

            if [[ -w "$dir" ]]; then
                rm -f "$completion_file"
            else
                print_info "Need sudo to remove completion from $(dirname $completion_file)"
                sudo rm -f "$completion_file"
            fi

            print_success "Bash completion removed from $completion_file"
        fi
    done

    if [[ "$found" == false ]]; then
        print_warn "Bash completion not found"
    fi
}

uninstall_zsh_completion() {
    local completion_dirs=(
        "/usr/local/share/zsh/site-functions/_${CLI_NAME}"
        "/usr/share/zsh/site-functions/_${CLI_NAME}"
        "$HOME/.local/share/zsh/site-functions/_${CLI_NAME}"
    )

    local found=false
    for completion_file in "${completion_dirs[@]}"; do
        if [[ -f "$completion_file" ]]; then
            found=true
            local dir=$(dirname "$completion_file")

            if [[ -w "$dir" ]]; then
                rm -f "$completion_file"
            else
                print_info "Need sudo to remove completion from $(dirname $completion_file)"
                sudo rm -f "$completion_file"
            fi

            print_success "Zsh completion removed from $completion_file"
        fi
    done

    local zsh_configs=("$HOME/.zshrc" "$HOME/.zshenv" "$HOME/.zprofile")
    for config_file in "${zsh_configs[@]}"; do
        if [[ -f "$config_file" ]] && grep -q "# Added by sidoc-cli installer" "$config_file"; then
            print_warn "Found sidoc-cli installer entries in $config_file"
            print_info "You may want to manually remove the fpath additions from $config_file"
        fi
    done

    if [[ "$found" == false ]]; then
        print_warn "Zsh completion not found"
    fi
}

uninstall_fish_completion() {
    local completion_dirs=(
        "/usr/share/fish/vendor_completions.d/${CLI_NAME}.fish"
        "$HOME/.config/fish/completions/${CLI_NAME}.fish"
    )

    local found=false
    for completion_file in "${completion_dirs[@]}"; do
        if [[ -f "$completion_file" ]]; then
            found=true
            local dir=$(dirname "$completion_file")

            if [[ -w "$dir" ]]; then
                rm -f "$completion_file"
            else
                print_info "Need sudo to remove completion from $(dirname $completion_file)"
                sudo rm -f "$completion_file"
            fi

            print_success "Fish completion removed from $completion_file"
        fi
    done

    if [[ "$found" == false ]]; then
        print_warn "Fish completion not found"
    fi
}

show_help() {
    echo -e "${BOLD}Usage:${RESET}"
    echo -e "  $0 [options]"
    echo
    echo -e "${BOLD}Options:${RESET}"
    echo -e "  ${GREEN}--bash-only${RESET}     Remove bash completion only"
    echo -e "  ${GREEN}--zsh-only${RESET}      Remove zsh completion only"
    echo -e "  ${GREEN}--fish-only${RESET}     Remove fish completion only"
    echo -e "  ${GREEN}--completions${RESET}   Remove all completions only (keep CLI)"
    echo -e "  ${GREEN}--help${RESET}          Show this help message"
    echo
    echo -e "${BOLD}Environment Variables:${RESET}"
    echo -e "  ${CYAN}INSTALL_DIR${RESET}     Directory where the CLI binary is installed (default: /usr/local/bin)"
    echo
    echo -e "${BOLD}Examples:${RESET}"
    echo -e "  $0                  ${DIM}# Complete uninstall (CLI + all completions)${RESET}"
    echo -e "  $0 --completions    ${DIM}# Remove all completions only${RESET}"
    echo -e "  $0 --bash-only      ${DIM}# Remove bash completion only${RESET}"
}

main() {
    local remove_cli=true
    local remove_bash=true
    local remove_zsh=true
    local remove_fish=true

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --bash-only)
                remove_cli=false
                remove_zsh=false
                remove_fish=false
                shift
                ;;
            --zsh-only)
                remove_cli=false
                remove_bash=false
                remove_fish=false
                shift
                ;;
            --fish-only)
                remove_cli=false
                remove_bash=false
                remove_zsh=false
                shift
                ;;
            --completions)
                remove_cli=false
                shift
                ;;
            --help|-h)
                show_help
                exit 0
                ;;
            *)
                print_error "Unknown option: $1. Use --help for usage."
                ;;
        esac
    done

    print_header

    if [[ "$remove_cli" == true ]]; then
        uninstall_cli || true
    fi

    if [[ "$remove_bash" == true ]]; then
        print_step "Removing bash completion"
        uninstall_bash_completion
        echo
    fi

    if [[ "$remove_zsh" == true ]]; then
        print_step "Removing zsh completion"
        uninstall_zsh_completion
        echo
    fi

    if [[ "$remove_fish" == true ]]; then
        print_step "Removing fish completion"
        uninstall_fish_completion
        echo
    fi

    echo -e "${BOLD}═══════════════════════════════════${RESET}"
    echo -e "${CHECK} ${BOLD}Uninstallation complete!${RESET}"
    echo
}

main "$@"
