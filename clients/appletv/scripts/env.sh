# Source before `ns` commands: NativeScript edits the Xcode project with the xcodeproj gem, which
# Homebrew's CocoaPods ships for Homebrew's Ruby (macOS's own Ruby is too old).
#   brew install cocoapods
RUBY_BIN=/opt/homebrew/opt/ruby/bin
POD_GEMS=$(ls -d /opt/homebrew/Cellar/cocoapods/*/libexec 2>/dev/null | tail -1)
export PATH="$RUBY_BIN:$PATH"
export GEM_PATH="$POD_GEMS:$("$RUBY_BIN/ruby" -e 'print Gem.default_path.join(":")')"
unset GEM_HOME
export LC_ALL=en_US.UTF-8
