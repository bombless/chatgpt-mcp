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
  | 'write_file'
  | 'edit_file'
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
  | 'gradle_assemble_debug'
  | 'gradle_install_debug'
  | 'run_python'
  | 'python_job_inspect'
  | 'python_job_kill'
  | 'python_jobs'
  | 'run_node'
  | 'read_file_range'
  | 'tail_file'
  | 'get_file_info'
  | 'create_directory'
  | 'copy_file'
  | 'process_list'
  | 'kill_process'
  | 'rg'
  | 'git'
  | 'apply_patch'
  | 'find_files'
  | 'cdp_version'
  | 'cdp_list_targets'
  | 'cdp_call';
