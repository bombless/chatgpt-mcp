import { getProxyInfo } from './shared.js';
import { readImageFile, editFile, rg, findFiles, readFileRange, tailFile, fileInfo, createDirectory, copyFile } from './filesystem.js';
import { git, applyPatch } from './git.js';
import { runNpmTool, runGradleTool, runPython, runNode, inspectPythonJob, killPythonJob, listPythonJobs, processList, killProcess } from './runtime.js';
import { getScreenInfo, getScreenPixel, takeScreenshot, clickMouse, moveMouse, scrollMouse, takeAdbScreenshot } from './desktop.js';
import { runBrowserTool } from './browser.js';
export { setCommandExecutionEnabled, assertAllowed } from './shared.js';
export { getProxyInfo } from './shared.js';
export type { ProxyInfo } from './shared.js';

export async function runCodingTool(tool: string, args: Record<string, unknown>, workspaceRoot: string, logCommand?: (command: string, cwd?: string) => void): Promise<unknown> {
  switch (tool) {
    case 'get_screen_info': return getScreenInfo();
    case 'take_screenshot': return takeScreenshot(args);
    case 'take_adb_screenshot': return takeAdbScreenshot(args);
    case 'read_image_file': return readImageFile(args, workspaceRoot);
    case 'click_mouse': return clickMouse(args);
    case 'move_mouse': return moveMouse(args);
    case 'scroll_mouse': return scrollMouse(args);
    case 'get_screen_pixel': return getScreenPixel(args);
    case 'npm_test': case 'npm_run': case 'npm_install': case 'npm_init': return runNpmTool(tool, args, workspaceRoot, logCommand);
    case 'gradle_assemble_debug': case 'gradle_install_debug': return runGradleTool(tool, args, workspaceRoot, logCommand);
    case 'run_python': return runPython(args, workspaceRoot, logCommand);
    case 'python_job_inspect': return inspectPythonJob(args);
    case 'python_job_kill': return killPythonJob(args, workspaceRoot);
    case 'python_jobs': return listPythonJobs();
    case 'run_node': return runNode(args, workspaceRoot, logCommand);
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
    case 'cdp_version': case 'cdp_list_targets': case 'cdp_call': return runBrowserTool(tool, args);
    default: throw new Error(`Unsupported coding tool: ${tool}`);
  }
}
