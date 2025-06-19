"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// Real unit test using the actual ContextManager class
const ContextManager_1 = require("./core/context/context-management/ContextManager");
// Create a test instance of ContextManager
const contextManager = new ContextManager_1.ContextManager();
// Create realistic message arrays that match your actual usage
function createTestMessages() {
    return [
        {
            role: "user",
            content: [{ type: "text", text: "<task>read ../test/heavy.md</task><environment_details>..." }]
        },
        {
            role: "assistant",
            content: [{ type: "text", text: "The task is to read the file `../test/heavy.md` in PLAN MODE..." }]
        },
        {
            role: "user",
            content: [{ type: "text", text: "[list_files for '/Users/max/Documents/test'] Result:.DS_Store heavy.md..." }]
        },
        {
            role: "assistant",
            content: [{ type: "text", text: "Now let me examine the context management code..." }]
        },
        {
            role: "user",
            content: [{ type: "text", text: "[read_file for 'src/core/context/context-management/ContextManager.ts'] Result:import { getContextWindowInfo }..." }]
        },
        {
            role: "assistant",
            content: [{ type: "text", text: "I can see the issue in the ContextManager.ts file..." }]
        },
        {
            role: "user",
            content: [{ type: "text", text: "[replace_in_file for 'src/core/context/context-management/ContextManager.ts'] Result:The file was updated..." }]
        },
        {
            role: "assistant",
            content: [{ type: "text", text: "I've updated the context management logic..." }]
        }
    ];
}
// Test function that calls the real ContextManager methods
function testRealContextManager() {
    console.log("=== TESTING REAL CONTEXT MANAGER ===\n");
    const allMessages = createTestMessages();
    console.log("Created test conversation with", allMessages.length, "messages");
    console.log("Message roles:", allMessages.map(m => m.role).join(" -> "));
    console.log();
    // Test the sliding window at different conversation lengths
    for (let length = 1; length <= allMessages.length; length++) {
        const currentMessages = allMessages.slice(0, length);
        console.log(`--- Turn ${length}: Testing with ${currentMessages.length} messages ---`);
        console.log("Input roles:", currentMessages.map(m => m.role).join(" -> "));
        // Call the REAL getTruncatedMessages method
        const result = contextManager.getTruncatedMessages(currentMessages, undefined);
        console.log("Output roles:", result.map(m => m.role).join(" -> "));
        console.log("Output count:", result.length);
        // Check if window advances from previous turn
        if (length > 3) {
            const prevMessages = allMessages.slice(0, length - 1);
            const prevResult = contextManager.getTruncatedMessages(prevMessages, undefined);
            // Compare the actual message content to see if window advanced
            const currentRoles = result.map(m => m.role).join(",");
            const prevRoles = prevResult.map(m => m.role).join(",");
            const advanced = currentRoles !== prevRoles;
            console.log("Window advanced from previous turn:", advanced ? "✅ YES" : "❌ NO (STUCK!)");
            if (!advanced) {
                console.log("ERROR: Window is stuck! This means the fix didn't work.");
                console.log("Previous result:", prevRoles);
                console.log("Current result:", currentRoles);
            }
            else {
                console.log("SUCCESS: Window is advancing properly!");
            }
        }
        console.log();
    }
    // Test your exact scenario from the logs
    console.log("=== TESTING YOUR EXACT LOG SCENARIO ===");
    const turn1Messages = allMessages.slice(0, 2); // user + assistant
    const turn2Messages = allMessages.slice(0, 4); // user + assistant + user + assistant  
    const turn3Messages = allMessages.slice(0, 6); // user + assistant + user + assistant + user + assistant
    const turn1Result = contextManager.getTruncatedMessages(turn1Messages, undefined);
    const turn2Result = contextManager.getTruncatedMessages(turn2Messages, undefined);
    const turn3Result = contextManager.getTruncatedMessages(turn3Messages, undefined);
    console.log("Turn 1 (2 messages):", turn1Result.map(m => m.role).join(" -> "));
    console.log("Turn 2 (4 messages):", turn2Result.map(m => m.role).join(" -> "));
    console.log("Turn 3 (6 messages):", turn3Result.map(m => m.role).join(" -> "));
    const turn2to3Advanced = JSON.stringify(turn2Result) !== JSON.stringify(turn3Result);
    console.log("Turn 2->3 advanced:", turn2to3Advanced ? "✅ YES" : "❌ NO (STUCK!)");
    if (turn2to3Advanced) {
        console.log("\n🎉 SUCCESS: The nuclear fix works! The sliding window advances properly.");
        console.log("When you rebuild and reinstall, you should see the context window advancing.");
    }
    else {
        console.log("\n❌ FAILURE: The fix didn't work. The window is still stuck.");
    }
}
// Run the test
testRealContextManager();
