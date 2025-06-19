# Tool Result Truncation Feature

## Overview

This document describes the tool result truncation feature implemented in Skyline to handle cases where bot tool results exceed the context window limits.

## Problem

When tools (like `read_file`, `list_files`, `search_files`, etc.) return very large results, they can cause the next API request to exceed the context window, leading to API errors and task failures.

## Solution

We implemented a simple truncation mechanism that limits the size of tool results before they are added to the conversation context.

## Implementation Details

### Configuration

The truncation limits are configured in `src/core/context/context-management/context-window-utils.ts`:

```typescript
export const TOOL_RESULT_LIMITS = {
	MAX_TOOL_RESULT_SIZE: 256 * 1024, // 256KB in bytes
	TRUNCATION_SUFFIX: "\n\n===TOOL RESULT OVER THE LIMIT AND CONTENT IS TRUNCATED==="
}
```

### Key Features

- **Configurable Limit**: The maximum tool result size is set to 256KB by default, which works well for most context windows while leaving room for conversation history.
- **Clear Indication**: When truncation occurs, a clear message is appended to indicate that the content was truncated.
- **File-based Configuration**: The limit is stored in a file so it can be easily adjusted for testing and optimization.

### How It Works

1. When a tool returns a string result, the `pushToolResult` function in `src/core/task/index.ts` checks if the content length exceeds `TOOL_RESULT_LIMITS.MAX_TOOL_RESULT_SIZE`.

2. If the content is too large:
   - The content is truncated to the maximum allowed size
   - The truncation suffix is appended to indicate the content was cut off

3. The processed content is then added to the user message content for the next API request.

### Code Location

The truncation logic is implemented in the `pushToolResult` function within `src/core/task/index.ts`:

```typescript
if (typeof content === "string") {
    // Apply truncation to string content if it exceeds the limit
    let processedContent = content || "(tool did not return anything)"
    if (processedContent.length > TOOL_RESULT_LIMITS.MAX_TOOL_RESULT_SIZE) {
        processedContent = processedContent.substring(0, TOOL_RESULT_LIMITS.MAX_TOOL_RESULT_SIZE) + 
                        TOOL_RESULT_LIMITS.TRUNCATION_SUFFIX
    }
    // ... rest of the function
}
```

## Benefits

1. **Prevents Context Window Errors**: Eliminates API failures due to oversized tool results
2. **Maintains Functionality**: Tools continue to work even with large outputs
3. **User Awareness**: Clear indication when content has been truncated
4. **Configurable**: Easy to adjust limits based on different context window sizes
5. **Simple Implementation**: Minimal code changes with maximum impact

## Future Enhancements

Potential improvements that could be considered:

1. **Smart Truncation**: Instead of simple truncation, implement intelligent summarization for different tool types
2. **Dynamic Limits**: Adjust truncation based on available context space
3. **Tool-Specific Limits**: Different limits for different types of tools
4. **Chunking**: Break large results into smaller chunks and process iteratively

## Configuration

To adjust the truncation limit, modify the `MAX_TOOL_RESULT_SIZE` value in `src/core/context/context-management/context-window-utils.ts`. The value is in bytes, so:

- 256KB = 256 * 1024 = 262,144 bytes
- 512KB = 512 * 1024 = 524,288 bytes
- 1MB = 1024 * 1024 = 1,048,576 bytes

## Testing

To test the truncation feature:

1. Use a tool that returns large content (e.g., `read_file` on a large file)
2. Verify that when the content exceeds 256KB, it gets truncated
3. Check that the truncation message appears at the end of the result
4. Ensure the conversation continues normally after truncation
