---
name: tsn-flow-planning
description: Generate and validate the flow planning stage for TSN Agent using the project runner
---

# TSN Flow Planning Skill

Use this skill when the user is describing or changing the TSN flow planning stage.

## Contract

- Stable stage id: `flow-template`
- Skill name: `tsn-flow-planning`
- Output schema: `tsn-agent.stage-skill-result.v0`
- The only state-changing output is the JSON written by `tsn-stage-runner`.

## Required Runner Call

Call the project runner with the current user intent, current canonical project, and the result path provided by the host:

```bash
node "$TSN_AGENT_STAGE_RUNNER_PATH" --stage flow-template --input '<json>' --result-path "$TSN_AGENT_STAGE_RESULT_PATH"
```

The input JSON should include:

- `userIntent`: latest user request.
- `scenarioConfigId`: current scenario config id when available.
- `project`: current canonical TSN project before applying this user request.

Do not hand-write the final JSON result. The runner generates and validates the canonical project.

## User Reply

After the runner finishes, explain the flow planning summary in Chinese and ask the user to confirm or describe changes. Do not claim that export files, planner output, or simulation execution have already completed.
