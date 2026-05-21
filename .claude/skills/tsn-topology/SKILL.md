---
name: tsn-topology
description: Generate and validate the topology stage for TSN Agent using the project runner
---

# TSN Topology Skill

Use this skill when the user is describing or changing the TSN topology stage.

## Contract

- Stable stage id: `topology`
- Skill name: `tsn-topology`
- Output schema: `tsn-agent.stage-skill-result.v0`
- The only state-changing output is the JSON written by `tsn-stage-runner`.

## Required Runner Call

Call the project runner with the current user intent and the result path provided by the host:

```bash
node "$TSN_AGENT_STAGE_RUNNER_PATH" --stage topology --input '<json>' --result-path "$TSN_AGENT_STAGE_RESULT_PATH"
```

The input JSON should include:

- `userIntent`: latest user request.
- `scenarioConfigId`: current scenario config id when available.
- `fallbackIntent`: previous topology counts when the user is editing an existing topology.

Do not hand-write the final JSON result. The runner generates and validates the canonical project.

## User Reply

After the runner finishes, explain the topology summary in Chinese and ask the user to confirm or describe changes. Do not claim that later time sync, flow planning, export files, or simulation have already completed.
