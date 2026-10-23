param(
    [Parameter(Mandatory=$true)]
    [int]$X,
    [Parameter(Mandatory=$true)]
    [int]$Y
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Threading;
using System.Runtime.InteropServices;

public class Win32MouseMove {
    [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr OpenDesktop(string lpszDesktop, int dwFlags, bool fInherit, uint dwDesiredAccess);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetThreadDesktop(IntPtr hDesktop);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool CloseDesktop(IntPtr hDesktop);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool GetCursorPos(out POINT lpPoint);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetCursorPos(int X, int Y);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    public static POINT Move(int targetX, int targetY) {
        POINT pt = new POINT();
        Exception err = null;
        Thread t = new Thread(() => {
            IntPtr hDesk = OpenDesktop("default", 0, false, 0x01FF);
            if (hDesk != IntPtr.Zero) {
                SetThreadDesktop(hDesk);
            }
            try {
                SetCursorPos(targetX, targetY);
                Thread.Sleep(20);
                GetCursorPos(out pt);
            } catch (Exception ex) {
                err = ex;
            } finally {
                if (hDesk != IntPtr.Zero) CloseDesktop(hDesk);
            }
        });
        t.Start();
        t.Join();
        if (err != null) throw err;
        return pt;
    }
}
"@

$finalPos = [Win32MouseMove]::Move($X, $Y)
Write-Output "MOVE_RESULT:{`"ok`":true,`"x`":$($finalPos.X),`"y`":$($finalPos.Y)}"
