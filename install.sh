#!/usr/bin/env bash

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_SCRIPT="${SCRIPT_DIR}/sidoc-cli.sh"
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

# Install CLI binary
install_cli() {
    info "Installing sidoc-cli to ${INSTALL_DIR}..."

    if [[ ! -f "$CLI_SCRIPT" ]]; then
        error "CLI script not found at $CLI_SCRIPT"
    fi

    # Make script executable
    chmod +x "$CLI_SCRIPT"

    # Check if we need sudo
    if [[ -w "$INSTALL_DIR" ]]; then
        ln -sf "$CLI_SCRIPT" "${INSTALL_DIR}/${CLI_NAME}"
    else
        info "Need sudo to install to ${INSTALL_DIR}..."
        sudo ln -sf "$CLI_SCRIPT" "${INSTALL_DIR}/${CLI_NAME}"
    fi

    success "sidoc-cli installed to ${INSTALL_DIR}/${CLI_NAME}"
}

# Install bash completion
install_bash_completion() {
    local completion_file="${SCRIPT_DIR}/completions/sidoc-cli.bash"
    local completion_dirs=(
        "/etc/bash_completion.d"
        "/usr/local/etc/bash_completion.d"
        "/usr/share/bash-completion/completions"
        "$HOME/.local/share/bash-completion/completions"
    )

    if [[ ! -f "$completion_file" ]]; then
        warning "Bash completion file not found at $completion_file"
        return 1
    fi

    # Find first writable completion directory
    local target_dir=""
    for dir in "${completion_dirs[@]}"; do
        if [[ -d "$dir" ]] && [[ -w "$dir" ]]; then
            target_dir="$dir"
            break
        fi
    done

    # If no writable dir found, try creating user-local one
    if [[ -z "$target_dir" ]]; then
        target_dir="$HOME/.local/share/bash-completion/completions"
        mkdir -p "$target_dir"
    fi

    # Check if we need sudo
    if [[ -w "$target_dir" ]]; then
        cp "$completion_file" "${target_dir}/${CLI_NAME}"
    else
        info "Need sudo to install completion to ${target_dir}..."
        sudo cp "$completion_file" "${target_dir}/${CLI_NAME}"
    fi

    success "Bash completion installed to ${target_dir}/${CLI_NAME}"
    info "Reload your shell or run: source ${target_dir}/${CLI_NAME}"
}

# Install zsh completion
install_zsh_completion() {
    local completion_file="${SCRIPT_DIR}/completions/sidoc-cli.zsh"
    local completion_dirs=(
        "/usr/local/share/zsh/site-functions"
        "/usr/share/zsh/site-functions"
        "$HOME/.local/share/zsh/site-functions"
    )

    if [[ ! -f "$completion_file" ]]; then
        warning "Zsh completion file not found at $completion_file"
        return 1
    fi

    # Find first writable completion directory
    local target_dir=""
    for dir in "${completion_dirs[@]}"; do
        if [[ -d "$dir" ]] && [[ -w "$dir" ]]; then
            target_dir="$dir"
            break
        fi
    done

    # If no writable dir found, try creating user-local one
    if [[ -z "$target_dir" ]]; then
        target_dir="$HOME/.local/share/zsh/site-functions"
        mkdir -p "$target_dir"

        # Add to fpath if not already there (must be BEFORE compinit)
        local zshrc="$HOME/.zshrc"
        if [[ -f "$zshrc" ]] && ! grep -q "sidoc-cli installer" "$zshrc"; then
            # Find if there's already a compinit call
            if grep -q "autoload.*compinit" "$zshrc"; then
                # Insert fpath before the compinit line
                local temp_file=$(mktemp)
                awk -v dir="$target_dir" '
                    /autoload.*compinit/ && !inserted {
                        print ""
                        print "# Added by sidoc-cli installer"
                        print "fpath=(" dir " $fpath)"
                        inserted=1
                    }
                    {print}
                ' "$zshrc" > "$temp_file"
                mv "$temp_file" "$zshrc"
                info "Added $target_dir to fpath before compinit in $zshrc"
            else
                # No compinit found, add both
                echo "" >> "$zshrc"
                echo "# Added by sidoc-cli installer" >> "$zshrc"
                echo "fpath=($target_dir \$fpath)" >> "$zshrc"
                echo "autoload -Uz compinit && compinit" >> "$zshrc"
                info "Added $target_dir to fpath and compinit in $zshrc"
            fi
        fi
    fi

    # Copy to tmp first, then create the properly named file
    local tmp_file=$(mktemp)
    cp "$completion_file" "$tmp_file"

    info "File copied to temporary location $tmp_file"

    # Check if we need sudo
    if [[ -w "$target_dir" ]]; then
        info "Installing completion to ${target_dir}/_${CLI_NAME}... without sudo"
        mv "$tmp_file" "${target_dir}/_${CLI_NAME}"
    else
        info "Need sudo to install completion to ${target_dir}..."
        sudo mv "$tmp_file" "${target_dir}/_${CLI_NAME}"
    fi

    success "Zsh completion installed to ${target_dir}/_${CLI_NAME}"
    info "Reload your shell or run: exec zsh"
}

# Install fish completion
install_fish_completion() {
    local completion_file="${SCRIPT_DIR}/completions/sidoc-cli.fish"
    local completion_dirs=(
        "/usr/share/fish/vendor_completions.d"
        "$HOME/.config/fish/completions"
    )

    if [[ ! -f "$completion_file" ]]; then
        warning "Fish completion file not found at $completion_file"
        return 1
    fi

    # Find first writable completion directory
    local target_dir=""
    for dir in "${completion_dirs[@]}"; do
        if [[ -d "$dir" ]] && [[ -w "$dir" ]]; then
            target_dir="$dir"
            break
        fi
    done

    # If no writable dir found, try creating user-local one
    if [[ -z "$target_dir" ]]; then
        target_dir="$HOME/.config/fish/completions"
        mkdir -p "$target_dir"
    fi

    # Check if we need sudo
    if [[ -w "$target_dir" ]]; then
        cp "$completion_file" "${target_dir}/${CLI_NAME}.fish"
    else
        info "Need sudo to install completion to ${target_dir}..."
        sudo cp "$completion_file" "${target_dir}/${CLI_NAME}.fish"
    fi

    success "Fish completion installed to ${target_dir}/${CLI_NAME}.fish"
    info "Completions should be available immediately in new fish shells"
}

# Show usage
show_usage() {
    cat << EOF
sidoc-cli Installer

Usage: $0 [OPTIONS]

Options:
    --bash          Install bash completion only
    --zsh           Install zsh completion only
    --fish          Install fish completion only
    --all-shells    Install completions for all shells
    --no-completion Skip completion installation
    --help          Show this help message

Environment Variables:
    INSTALL_DIR     Directory to install the CLI binary (default: /usr/local/bin)

Examples:
    $0                      # Install CLI and detect current shell for completion
    $0 --all-shells         # Install CLI and completions for all shells
    $0 --bash               # Install CLI and bash completion only
    $0 --no-completion      # Install CLI only, no completions
EOF
}

# Main installation
main() {
    local install_bash=false
    local install_zsh=false
    local install_fish=false
    local auto_detect=true

    # Parse arguments
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
    echo "║   SIDOC CLI Installer              ║"
    echo "╚════════════════════════════════════╝"
    echo ""

    # Install CLI
    install_cli

    # Auto-detect shell if no specific options provided
    if [[ "$auto_detect" == true ]]; then
        local detected_shell=$(detect_shell)
        if [[ -n "$detected_shell" ]]; then
            info "Detected shell: $detected_shell"
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
            warning "Could not detect shell. Skipping completion installation."
            warning "Run with --bash, --zsh, or --fish to install completions manually."
        fi
    fi

    # Install completions
    echo ""
    if [[ "$install_bash" == true ]]; then
        install_bash_completion || true
    fi

    if [[ "$install_zsh" == true ]]; then
        install_zsh_completion || true
    fi

    if [[ "$install_fish" == true ]]; then
        install_fish_completion || true
    fi

    echo ""
    success "Installation complete!"
    echo ""
    info "Try running: sidoc-cli --help"
    echo ""
}

main "$@"
