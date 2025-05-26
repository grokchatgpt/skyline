# skyline API

The skyline extension exposes an API that can be used by other extensions. To use this API in your extension:

1. Copy `src/extension-api/skyline.d.ts` to your extension's source directory.
2. Include `skyline.d.ts` in your extension's compilation.
3. Get access to the API with the following code:

    ```ts
    const skylineExtension = vscode.extensions.getExtension<skylineAPI>("saoudrizwan.claude-dev")

    if (!skylineExtension?.isActive) {
    	throw new Error("skyline extension is not activated")
    }

    const skyline = skylineExtension.exports

    if (skyline) {
    	// Now you can use the API

    	// Set custom instructions
    	await skyline.setCustomInstructions("Talk like a pirate")

    	// Get custom instructions
    	const instructions = await skyline.getCustomInstructions()
    	console.log("Current custom instructions:", instructions)

    	// Start a new task with an initial message
    	await skyline.startNewTask("Hello, skyline! Let's make a new project...")

    	// Start a new task with an initial message and images
    	await skyline.startNewTask("Use this design language", ["data:image/webp;base64,..."])

    	// Send a message to the current task
    	await skyline.sendMessage("Can you fix the @problems?")

    	// Simulate pressing the primary button in the chat interface (e.g. 'Save' or 'Proceed While Running')
    	await skyline.pressPrimaryButton()

    	// Simulate pressing the secondary button in the chat interface (e.g. 'Reject')
    	await skyline.pressSecondaryButton()
    } else {
    	console.error("skyline API is not available")
    }
    ```

    **Note:** To ensure that the `saoudrizwan.claude-dev` extension is activated before your extension, add it to the `extensionDependencies` in your `package.json`:

    ```json
    "extensionDependencies": [
        "saoudrizwan.claude-dev"
    ]
    ```

For detailed information on the available methods and their usage, refer to the `skyline.d.ts` file.
