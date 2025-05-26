## Step 1: Clean and Prepare Environment

```bash
# Remove node_modules to ensure clean state
rm -rf node_modules
rm -rf webview-ui/node_modules

# If you want to completely start fresh, you could also clean the build artifacts
rm -rf dist
rm -rf out
```

## Step 2: Install Dependencies

```bash
# Install both main project and webview-ui dependencies in one command
npm run install:all
```

## Step 3: Generate Protocol Buffers

```bash
# Generate proto files needed for the build
npm run protos
```

## Step 4: Build the Extension Package

```bash
# Build the complete extension for production
npm run package
```

## Step 5: Install the Extension in VSCode

```bash
# Package into VSIX
npx vsce package
```
