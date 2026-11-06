import { cdpCall, cdpListTargets, cdpVersion } from './cdp.js';
import {
  setCommandExecutionEnabled,
  assertAllowed,
  command,
  type CommandLogger,
} from './coding-tools/common.js';
import { getProxyInfo, type ProxyInfo } from './coding-tools/proxy-tools.js';
import {
  readImageFile,
  editFile,
  readFileRange,
  tailFile,
  fileInfo,
  createDirectory,
  copyFile,
  rg,
  findFiles,
} from './coding-tools/file-tools.js';
import {
  runNpmTool,
  runGradleTool,
  runPython,
  inspectPythonJob,
  killPythonJob,
  listPythonJobs,
  processList,
  killProcess,
} from './coding-tools/runtime-tools.js';
import { git, applyPatch } from './coding-tools/git-tools.js';
import {
  getScreenInfo,
  getScreenPixel,
  takeScreenshot,
  clickMouse,
  moveMouse,
  scrollMouse,
  takeAdbScreenshot,
} from './coding-tools/screen-tools.js';

export { setCommandExecutionEnabled, assertAllowed, getProxyInfo, type ProxyInfo };

export async function runCodingTool(
  tool: string,
  args: Record<string, unknown>,
  workspaceRoot: string,
  logCommand?: CommandLogger
): Promise<unknown> {
  switch (tool) {
    case 'get_screen_info': return getScreenInfo();
    case 'take_screenshot': return takeScreenshot(args);
    case 'take_adb_screenshot': return takeAdbScreenshot(args);
    case 'read_image_file': return readImageFile(args, workspaceRoot);
    case 'click_mouse': return clickMouse(args);
    case 'move_mouse': return moveMouse(args);
    case 'scroll_mouse': return scrollMouse(args);
    case 'get_screen_pixel': return getScreenPixel(args);
    case 'npm_test': return runNpmTool('npm_test', args, workspaceRoot, logCommand);
    case 'npm_run': return runNpmTool('npm_run', args, workspaceRoot, logCommand);
    case 'npm_install': return runNpmTool('npm_install', args, workspaceRoot, logCommand);
    case 'npm_init': return runNpmTool('npm_init', args, workspaceRoot, logCommand);
    case 'gradle_assemble_debug': return runGradleTool('gradle_assemble_debug', args, workspaceRoot, logCommand);
    case 'gradle_install_debug': return runGradleTool('gradle_install_debug', args, workspaceRoot, logCommand);
    case 'run_python': return runPython(args, workspaceRoot, logCommand);
    case 'python_job_inspect': return inspectPythonJob(args);
    case 'python_job_kill': return killPythonJob(args, workspaceRoot);
    case 'python_jobs': return listPythonJobs();
    case 'run_node': return command('node', args, workspaceRoot, logCommand);
    case 'read_file_range': return readFileRange(args, workspaceRoot);
    case 'tail_file': return tailFile(args, workspaceRoot);
    case 'get_file_info': return fileInfo(args, workspaceRoot);
    case 'create_directory': return createDirectory(args, workspaceRoot);
    case 'copy_file': return copyFile(args, workspaceRoot);
    case 'process_list': return processList(workspaceRoot, logCommand);
    case 'kill_process': return killProcess(args, workspaceRoot, logCommand);
    case 'rg': return rg(args, workspaceRoot, logCommand);
    case 'git': return git(args, workspaceRoot, logCommand);
    case 'apply_patch': return applyPatch(args, workspaceRoot, logCommand);
    case 'edit_file': return editFile(args, workspaceRoot);
    case 'find_files': return findFiles(args, workspaceRoot, logCommand);
    case 'get_proxy_info': return getProxyInfo();
    case 'cdp_version': return cdpVersion();
    case 'cdp_list_targets': return cdpListTargets();
    case 'cdp_call': return cdpCall(args);
    default: throw new Error(`Unsupported coding tool: ${tool}`);
  }
}
