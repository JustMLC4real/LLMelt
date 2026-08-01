import type { AgentShell } from '../src/components/agent-commands';

export const AGENT_TOOL_INSTRUCTIONS = [
  '',
  'IMPORTANT - TOOL ACCESS: You are running inside LLMelt. This host can execute',
  'approved project tools for you after the user approves them. If the user asks you to',
  'read, inspect, create, write, build, run, test, edit, or modify a local file/app/script, use only',
  'these strict tags and then stop.',
  'Read an existing project/workspace text file:',
  '<file-read path="relative/path.txt"></file-read>',
  'Run a shell command:',
  '<run-command>the shell command</run-command>',
  'Create a new file:',
  '<file-create path="relative/path.txt">file contents</file-create>',
  'Edit an existing file by exact replacement:',
  '<file-edit path="relative/path.txt" old="exact old text">new text</file-edit>',
  'To write SOURCE CODE (Python, JS, …), use an empty marker followed immediately by one fenced code block:',
  '<file-create path="relative/script.py" source="next-fence"></file-create>',
  '```python',
  'def example():',
  '    return "indentation is preserved"',
  '```',
  'The host reads that next code block as raw file content and removes the fence. This external',
  'source block is required for source code because browser rendering can collapse indentation',
  'inside a custom tag. Keep ordinary non-source text inline in <file-create>/<file-edit>.',
  'NEVER write file contents via',
  'shell here-strings, echo, or Set-Content piping (e.g. @\'..\'@ | Set-Content): quoting and',
  'indentation get mangled and the script breaks. Create the file with <file-create>, then',
  'run it in a SEPARATE <run-command> (e.g. <run-command>python hello.py</run-command>).',
  'Never put a Markdown code fence inside the opening and closing tool tag. For source code it must',
  'come immediately AFTER the closed tag and the marker must contain source="next-fence".',
  'If a command fails, FIX the file with <file-edit> before re-running — do not re-run the',
  'same failing command unchanged.',
  'Never rely on bare code blocks or loose prose for tool execution. The host sends the',
  'real tool output back into the chat so you can continue.',
  'For requests to see, read, inspect, open, or check a local file path, emitting prose is',
  'NOT enough: emit a file-read tag. The host will return the real file content if allowed.',
  'For create/write/build requests, emitting only prose or a code block is NOT enough:',
  'you must emit a file-create or file-edit tag, even if the user did not ask to run it yet.',
  'Never say you created, edited, ran, tested, or saw output from local tools unless you',
  'first emitted the strict tool tags and then received Tool output from the host.',
  'Do not add pause/read-host/input prompts or other interactive waits to scripts unless',
  'the user explicitly asks for an interactive script.',
  'If a user requests both ANSI/color output and a final output without color codes, design the',
  'script with a deterministic --plain (or equivalent NO_COLOR) mode from the start and run that',
  'mode for the captured plain output. Do not repeatedly rerun successful scripts through different',
  'ANSI-stripping pipelines.',
].join('\n');

/**
 * Vertelt een model welk commandoformaat de app werkelijk uitvoert. De shell komt
 * uit de gebruikersinstelling; er wordt dus niets uit de modelnaam afgeleid.
 */
export function agentToolEnvironmentInstructions(
  shell: AgentShell,
  platform: NodeJS.Platform = process.platform,
) {
  const host = platform === 'win32'
    ? 'The host operating system is Windows.'
    : `The host operating system is ${platform}.`;
  const common = [
    '',
    'IMPORTANT - COMMAND ENVIRONMENT:',
    host,
    `The selected command shell is ${shell}.`,
    'Every command starts in the active project/workspace directory.',
    'Use one non-interactive command per <run-command> tag and wait for its real output.',
  ];

  if (platform !== 'win32') return common.join('\n');
  if (shell === 'cmd') {
    return [
      ...common,
      'Write commands for cmd.exe. Do not use Bash syntax, /dev/null, or PowerShell variables/cmdlets.',
      'For Python, prefer the Windows command "python"; only use "py" after the host confirms it exists.',
    ].join('\n');
  }
  if (shell === 'pwsh') {
    return [
      ...common,
      'Write commands for PowerShell 7 (pwsh). Do not use Bash paths such as /dev/null.',
      'For Python, prefer the Windows command "python"; only use "py" after the host confirms it exists.',
    ].join('\n');
  }
  return [
    ...common,
    'Write commands for Windows PowerShell 5.1 compatibility.',
    'Never use Bash syntax, /dev/null, or the operators && and ||.',
    'Use ; plus an explicit $LASTEXITCODE check when sequential success is required, and use Out-Null or $null for discarded output.',
    'For Python, prefer the Windows command "python"; only use "py" after the host confirms it exists. Do not assume "python3" exists.',
  ].join('\n');
}
