# Minecraft Direct Tools Design

## Goal

Remove the independent Minecraft planner loop. Hiyori's existing agent loop owns user intent, action selection, multi-step reasoning, and user-facing replies. The Minecraft runtime only exposes perception and deterministic game actions.

## Boundaries

- Hiyori directly calls Minecraft perception and action operations through `minecraft_companion`.
- `plannerModel`, `cognitionCoordinator`, `start_goal`, and `stop_goal` are removed.
- Mineflayer, the worker process, the action registry, runtime events, and the existing reply-target routing remain.
- No second LLM loop, Minecraft-specific todo system, or compatibility fallback is retained.

## Tool Behavior

The tool exposes connection, chat, perception, search, movement, collection, combat, and cancellation operations. Tool results report facts and action state; they do not contain suggested dialogue.

Operations use three existing runtime behaviors:

- Immediate operations return their result in the current Hiyori turn: status, snapshot, block scan, searches, chat, and short bounded actions.
- Persistent operations establish a runtime state and return immediately: following a player.
- Long operations start a worker job and return an action ID immediately: collection and other actions whose duration depends on the world. Their terminal event returns through the existing wake-up route associated with the originating conversation.

## Multi-Step Work

Hiyori uses its normal loop to compose operations. If a long operation starts, the current turn ends normally. When the terminal event wakes the same conversation, the notification includes the original operation, action ID, outcome, and useful result data. Hiyori can then reply, call another Minecraft operation, or finish. Hiyori may use its existing todo capability, but Minecraft does not require or duplicate it.

## Failure And Cancellation

- A gameplay action failure never terminates the worker or disconnects the bot.
- Command timeouts remain only for bounded control requests. Long operations are governed by their own cancellation and terminal events.
- Cancelling an action stops that action through the adapter while preserving the connection.
- Worker termination is reserved for an actual worker crash, explicit shutdown, or unrecoverable connection setup failure.

## Notifications

- Immediate and persistent operations do not produce a second wake-up after their tool result.
- Long operations produce one terminal wake-up for completion, partial completion, cancellation, or failure.
- Detailed progress remains available to debug or terminal surfaces and is not pushed into chat.

## Verification

Tests must prove that Hiyori receives direct tool results, long operations return before completion, terminal events route once to the originating conversation, action timeout or cancellation does not kill the worker, and no planner/coordinator is initialized or exposed.
