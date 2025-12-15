#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_SCRIPT="${SCRIPT_DIR}/sidoc-cli.sh"
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
    echo -e "${BOLD}${MAGENTA}║${RESET}         ${BOLD}SIDOC CLI Installer${RESET}        ${BOLD}${MAGENTA}║${RESET}"
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

# Detect shell
detect_shell() {
    local shell_name=""

    # Get parent process (the shell that called this script)
    local ppid=$(ps -p $$ -o ppid= 2>/dev/null | tr -d ' ')

    if [[ -n "$ppid" ]]; then
        local parent_shell=$(ps -p "$ppid" -o comm= 2>/dev/null || echo "")
        case "$parent_shell" in
            *bash*)
                shell_name="bash"
                ;;
            *zsh*)
                shell_name="zsh"
                ;;
            *fish*)
                shell_name="fish"
                ;;
        esac
    fi

    # Fallback to SHELL variable if ps didn't work
    if [[ -z "$shell_name" ]]; then
        local shell_path="${SHELL:-}"
        # Extract just the shell name from the path
        case "$shell_path" in
            */bash)
                shell_name="bash"
                ;;
            */zsh)
                shell_name="zsh"
                ;;
            */fish)
                shell_name="fish"
                ;;
            *)
                # Last resort: extract basename
                if [[ -n "$shell_path" ]]; then
                    local basename="${shell_path##*/}"
                    case "$basename" in
                        bash|zsh|fish)
                            shell_name="$basename"
                            ;;
                    esac
                fi
                ;;
        esac
    fi

    echo "$shell_name"
}

install_cli() {
    print_step "Installing sidoc-cli to ${INSTALL_DIR}"

    if [[ ! -f "$CLI_SCRIPT" ]]; then
        print_error "CLI script not found at $CLI_SCRIPT"
    fi

    chmod +x "$CLI_SCRIPT"

    if [[ -w "$INSTALL_DIR" ]]; then
        ln -sf "$CLI_SCRIPT" "${INSTALL_DIR}/${CLI_NAME}"
    else
        print_info "Need sudo to install to ${INSTALL_DIR}"
        sudo ln -sf "$CLI_SCRIPT" "${INSTALL_DIR}/${CLI_NAME}"
    fi

    print_success "sidoc-cli installed to ${INSTALL_DIR}/${CLI_NAME}"
    echo
}

install_bash_completion() {
    local completion_file="${SCRIPT_DIR}/completions/sidoc-cli.bash"
    local completion_dirs=(
        "/etc/bash_completion.d"
        "/usr/local/etc/bash_completion.d"
        "/usr/share/bash-completion/completions"
        "$HOME/.local/share/bash-completion/completions"
    )

    if [[ ! -f "$completion_file" ]]; then
        print_warn "Bash completion file not found at $completion_file"
        return 1
    fi

    local target_dir=""
    for dir in "${completion_dirs[@]}"; do
        if [[ -d "$dir" ]] && [[ -w "$dir" ]]; then
            target_dir="$dir"
            break
        fi
    done

    if [[ -z "$target_dir" ]]; then
        target_dir="$HOME/.local/share/bash-completion/completions"
        mkdir -p "$target_dir"
    fi

    if [[ -w "$target_dir" ]]; then
        cp "$completion_file" "${target_dir}/${CLI_NAME}"
    else
        print_info "Need sudo to install completion to ${target_dir}"
        sudo cp "$completion_file" "${target_dir}/${CLI_NAME}"
    fi

    print_success "Bash completion installed to ${target_dir}/${CLI_NAME}"
    print_info "Reload your shell or run: source ${target_dir}/${CLI_NAME}"
}

install_zsh_completion() {
    local completion_file="${SCRIPT_DIR}/completions/sidoc-cli.zsh"
    local completion_dirs=(
        "/usr/local/share/zsh/site-functions"
        "/usr/share/zsh/site-functions"
        "$HOME/.local/share/zsh/site-functions"
    )

    if [[ ! -f "$completion_file" ]]; then
        print_warn "Zsh completion file not found at $completion_file"
        return 1
    fi

    local target_dir=""
    for dir in "${completion_dirs[@]}"; do
        if [[ -d "$dir" ]] && [[ -w "$dir" ]]; then
            target_dir="$dir"
            break
        fi
    done

    if [[ -z "$target_dir" ]]; then
        target_dir="$HOME/.local/share/zsh/site-functions"
        mkdir -p "$target_dir"

        local zsh_config=""
        for config_file in "$HOME/.zshrc" "$HOME/.zshenv" "$HOME/.zprofile"; do
            if [[ -f "$config_file" ]]; then
                zsh_config="$config_file"
                break
            fi
        done

        if [[ -z "$zsh_config" ]]; then
            zsh_config="$HOME/.zshrc"
            touch "$zsh_config"
        fi

        if ! grep -q "sidoc-cli installer" "$zsh_config"; then
            if grep -q "autoload.*compinit" "$zsh_config"; then
                local temp_file=$(mktemp)
                awk -v dir="$target_dir" '
                    /autoload.*compinit/ && !inserted {
                        print ""
                        print "# Added by sidoc-cli installer"
                        print "fpath=(" dir " $fpath)"
                        inserted=1
                    }
                    {print}
                ' "$zsh_config" > "$temp_file"
                mv "$temp_file" "$zsh_config"
                print_info "Added $target_dir to fpath before compinit in $zsh_config"
            else
                echo "" >> "$zsh_config"
                echo "# Added by sidoc-cli installer" >> "$zsh_config"
                echo "fpath=($target_dir \$fpath)" >> "$zsh_config"
                echo "autoload -Uz compinit && compinit" >> "$zsh_config"
                print_info "Added $target_dir to fpath and compinit in $zsh_config"
            fi
        fi
    fi

    local tmp_file=$(mktemp)
    cp "$completion_file" "$tmp_file"

    print_info "File copied to temporary location $tmp_file"

    if [[ -w "$target_dir" ]]; then
        print_info "Installing completion to ${target_dir}/_${CLI_NAME} without sudo"
        mv "$tmp_file" "${target_dir}/_${CLI_NAME}"
    else
        print_info "Need sudo to install completion to ${target_dir}"
        sudo mv "$tmp_file" "${target_dir}/_${CLI_NAME}"
    fi

    print_success "Zsh completion installed to ${target_dir}/_${CLI_NAME}"
    print_info "Reload your shell or run: exec zsh"
}

install_fish_completion() {
    local completion_file="${SCRIPT_DIR}/completions/sidoc-cli.fish"
    local completion_dirs=(
        "/usr/share/fish/vendor_completions.d"
        "$HOME/.config/fish/completions"
    )

    if [[ ! -f "$completion_file" ]]; then
        print_warn "Fish completion file not found at $completion_file"
        return 1
    fi

    local target_dir=""
    for dir in "${completion_dirs[@]}"; do
        if [[ -d "$dir" ]] && [[ -w "$dir" ]]; then
            target_dir="$dir"
            break
        fi
    done

    if [[ -z "$target_dir" ]]; then
        target_dir="$HOME/.config/fish/completions"
        mkdir -p "$target_dir"
    fi

    if [[ -w "$target_dir" ]]; then
        cp "$completion_file" "${target_dir}/${CLI_NAME}.fish"
    else
        print_info "Need sudo to install completion to ${target_dir}"
        sudo cp "$completion_file" "${target_dir}/${CLI_NAME}.fish"
    fi

    print_success "Fish completion installed to ${target_dir}/${CLI_NAME}.fish"
    print_info "Completions should be available immediately in new fish shells"
}

show_help() {
    echo -e "${BOLD}Usage:${RESET}"
    echo -e "  $0 [options]"
    echo
    echo -e "${BOLD}Options:${RESET}"
    echo -e "  ${GREEN}--bash${RESET}          Install bash completion only"
    echo -e "  ${GREEN}--zsh${RESET}           Install zsh completion only"
    echo -e "  ${GREEN}--fish${RESET}          Install fish completion only"
    echo -e "  ${GREEN}--all-shells${RESET}    Install completions for all shells"
    echo -e "  ${GREEN}--no-completion${RESET} Skip completion installation"
    echo -e "  ${GREEN}--help${RESET}          Show this help message"
    echo
    echo -e "${BOLD}Environment Variables:${RESET}"
    echo -e "  ${CYAN}INSTALL_DIR${RESET}     Directory to install the CLI binary (default: /usr/local/bin)"
    echo
    echo -e "${BOLD}Examples:${RESET}"
    echo -e "  $0                      ${DIM}# Install CLI and detect current shell for completion${RESET}"
    echo -e "  $0 --all-shells         ${DIM}# Install CLI and completions for all shells${RESET}"
    echo -e "  $0 --bash               ${DIM}# Install CLI and bash completion only${RESET}"
    echo -e "  $0 --no-completion      ${DIM}# Install CLI only, no completions${RESET}"
}

main() {
    local install_bash=false
    local install_zsh=false
    local install_fish=false
    local auto_detect=true

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --bash)
                install_bash=true
                auto_detect=false
                shift
                ;;
            --zsh)
                install_zsh=true
                auto_detect=false
                shift
                ;;
            --fish)
                install_fish=true
                auto_detect=false
                shift
                ;;
            --all-shells)
                install_bash=true
                install_zsh=true
                install_fish=true
                auto_detect=false
                shift
                ;;
            --no-completion)
                auto_detect=false
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

    install_cli

    if [[ "$auto_detect" == true ]]; then
        local detected_shell=$(detect_shell)
        if [[ -n "$detected_shell" ]]; then
            print_info "Detected shell: $detected_shell"
            case "$detected_shell" in
                bash)
                    install_bash=true
                    ;;
                zsh)
                    install_zsh=true
                    ;;
                fish)
                    install_fish=true
                    ;;
            esac
        else
            print_warn "Could not detect shell. Skipping completion installation."
            print_warn "Run with --bash, --zsh, or --fish to install completions manually."
        fi
    fi

    if [[ "$install_bash" == true ]]; then
        print_step "Installing bash completion"
        install_bash_completion || true
        echo
    fi

    if [[ "$install_zsh" == true ]]; then
        print_step "Installing zsh completion"
        install_zsh_completion || true
        echo
    fi

    if [[ "$install_fish" == true ]]; then
        print_step "Installing fish completion"
        install_fish_completion || true
        echo
    fi

    echo -e "${BOLD}═══════════════════════════════════${RESET}"
    echo -e "${CHECK} ${BOLD}Installation complete!${RESET}"
    echo
    print_info "Try running: ${BOLD}sidoc-cli --help${RESET}"
    echo
}

main "$@"
