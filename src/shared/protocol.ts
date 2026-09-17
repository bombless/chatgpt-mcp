export type AgentRequest = {
  type: 'request';
  id: string;
  tool: string;
  args: Record<string, unknown>;
};

export type AgentResponse = {
  type: 'response';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

export type AgentHello = {
  type: 'hello';
  agentId: string;
  hostname: string;
  platform: string;
  version: string;
};

export type AgentMessage = AgentHello | AgentResponse;

export type ToolName =
  | 'read_file'
  | 'replace_lines'
  | 'list_directory'
  | 'move_file'
  | 'delete_file'
  | 'execute_powershell'
  | 'execute_bash'
  | 'get_system_info'
  | 'npm_test'
  | 'npm_run'
  | 'npm_install'
  | 'npm_init'
  | 'run_python'
  | 'python_job_inspect'
  | 'python_job_kill'
  | 'python_jobs'
  | 'run_node'
  | 'get_file_info'
  | 'create_directory'
  | 'copy_file'
  | 'process_list'
  | 'kill_process'
  | 'rg'
  | 'git'
  | 'find_files'
  | 'cdp_version'
  | 'cdp_list_targets'
  | 'cdp_call';
