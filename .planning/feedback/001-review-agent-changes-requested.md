---
specialist: review-agent
issueId: PAN-513
outcome: changes-requested
timestamp: 2026-04-08T01:46:33Z
---

CODE REVIEW BLOCKED for PAN-513:

2 issues found:

1. DEAD CODE: src/dashboard/frontend/src/components/AgentOutputPanel.tsx — `const [terminalFailed, setTerminalFailed] = useState(false)` is added but NEVER used. onDisconnect is not wired to any <XTerminal> component and terminalFailed is never read. Either wire it properly (see PAN-510/PAN-511 for the correct pattern: `<XTerminal sessionName={agentId} onDisconnect={() => setTerminalFailed(true)} />`) or remove the dead state.

2. MISSING TESTS: MemoryWarningBanner.tsx has non-trivial dismiss/re-display logic and agent kill functionality but no test file. The project tests frontend components (KanbanBoard.test.tsx, XTerminal.test.tsx, InspectorPanel.test.tsx etc). Add at least basic tests for the threshold/dismiss/re-display logic.

All other changes are clean: sessionExistsAsync fix correct, memory guard two-tier approach is solid, env-loader tested, KanbanBoard confirm flow correct, sync.ts CLI execSync acceptable.

## REQUIRED: Fix ALL issues above BEFORE resubmitting

1. Read each blocking issue carefully
2. Fix the code for EVERY issue listed
3. Run tests to verify your fixes
4. Commit and push ALL changes
5. ONLY THEN resubmit:
curl -X POST http://localhost:3011/api/workspaces/PAN-513/request-review -H "Content-Type: application/json" -d '{}'

Do NOT run the curl command until steps 1-4 are complete. Do NOT stop until review passes.
