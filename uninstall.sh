#!/usr/bin/env bash

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"
CLI_NAME="sidoc-cli"

# Helper functions
error() {
    echo -e "${RED}Error:${NC} $1" >&2
    exit 1
}

success() {
    echo -e "${GREEN}✓${NC} $1"
}

info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

# Uninstall CLI binary
uninstall_cli() {
    local cli_path="${INSTALL_DIR}/${CLI_NAME}"

    if [[ ! -e "$cli_path" ]]; then
        warning "CLI not found at $cli_path"
        return 1
    fi

    info "Removing sidoc-cli from ${INSTALL_DIR}..."

    # Check if we need sudo
    if [[ -w "$INSTALL_DIR" ]]; then
        rm -f "$cli_path"
    else
        info "Need sudo to remove from ${INSTALL_DIR}..."
        sudo rm -f "$cli_path"
    fi

    success "sidoc-cli removed from ${INSTALL_DIR}"
}

# Uninstall bash completion
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
                info "Need sudo to remove completion from $(dirname $completion_file)..."
                sudo rm -f "$completion_file"
            fi

            success "Bash completion removed from $completion_file"
        fi
    done

    if [[ "$found" == false ]]; then
        warning "Bash completion not found"
    fi
}

# Uninstall zsh completion
uninstall_zsh_completion() {
    local completion_dirs=(
        "/usr/local/share/zsh/site-functions/${CLI_NAME}.zsh"
        "/usr/share/zsh/site-functions/${CLI_NAME}.zsh"
        "$HOME/.local/share/zsh/site-functions/${CLI_NAME}.zsh"
    )

    local found=false
    for completion_file in "${completion_dirs[@]}"; do
        if [[ -f "$completion_file" ]]; then
            found=true
            local dir=$(dirname "$completion_file")

            if [[ -w "$dir" ]]; then
                rm -f "$completion_file"
            else
                info "Need sudo to remove completion from $(dirname $completion_file)..."
                sudo rm -f "$completion_file"
            fi

            success "Zsh completion removed from $completion_file"
        fi
    done

    # Check if fpath was modified in .zshrc
    local zshrc="$HOME/.zshrc"
    if [[ -f "$zshrc" ]] && grep -q "# Added by sidoc-cli installer" "$zshrc"; then
        warning "Found sidoc-cli installer entries in $zshrc"
        info "You may want to manually remove the fpath additions from $zshrc"
    fi

    if [[ "$found" == false ]]; then
        warning "Zsh completion not found"
    fi
}

# Uninstall fish completion
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
                info "Need sudo to remove completion from $(dirname $completion_file)..."
                sudo rm -f "$completion_file"
            fi

            success "Fish completion removed from $completion_file"
        fi
    done

    if [[ "$found" == false ]]; then
        warning "Fish completion not found"
    fi
}

# Show usage
show_usage() {
    cat << EOF
sidoc-cli Uninstaller

Usage: $0 [OPTIONS]

Options:
    --bash-only     Remove bash completion only
    --zsh-only      Remove zsh completion only
    --fish-only     Remove fish completion only
    --completions   Remove all completions only (keep CLI)
    --help          Show this help message

Environment Variables:
    INSTALL_DIR     Directory where the CLI binary is installed (default: /usr/local/bin)

Examples:
    $0                  # Complete uninstall (CLI + all completions)
    $0 --completions    # Remove all completions only
    $0 --bash-only      # Remove bash completion only
EOF
}

# Main uninstallation
main() {
    local remove_cli=true
    local remove_bash=true
    local remove_zsh=true
    local remove_fish=true

    # Parse arguments
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
                show_usage
                exit 0
                ;;
            *)
                error "Unknown option: $1. Use --help for usage."
                ;;
        esac
    done

    echo ""
    echo "╔════════════════════════════════════╗"
    echo "║   SIDOC CLI Uninstaller            ║"
    echo "╚════════════════════════════════════╝"
    echo ""

    # Uninstall CLI
    if [[ "$remove_cli" == true ]]; then
        uninstall_cli || true
        echo ""
    fi

    # Uninstall completions
    if [[ "$remove_bash" == true ]]; then
        uninstall_bash_completion
        echo ""
    fi

    if [[ "$remove_zsh" == true ]]; then
        uninstall_zsh_completion
        echo ""
    fi

    if [[ "$remove_fish" == true ]]; then
        uninstall_fish_completion
        echo ""
    fi

    success "Uninstallation complete!"
    echo ""
}

main "$@"
