param(
    [Nullable[int]]$X,
    [Nullable[int]]$Y,
    [string]$Button = 'left',
    [int]$ClickCount = 1
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Threading;
using System.Runtime.InteropServices;

public class Win32MouseClicker {
    [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr OpenDesktop(string lpszDesktop, int dwFlags, bool fInherit, uint dwDesiredAccess);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetThreadDesktop(IntPtr hDesktop);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool CloseDesktop(IntPtr hDesktop);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool GetCursorPos(out POINT lpPoint);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll", SetLastError = true)] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    public const uint MOUSEEVENTF_LEFTDOWN   = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP     = 0x0004;
    public const uint MOUSEEVENTF_RIGHTDOWN  = 0x0008;
    public const uint MOUSEEVENTF_RIGHTUP    = 0x0010;
    public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    public const uint MOUSEEVENTF_MIDDLEUP   = 0x0040;

    public static POINT Click(int? targetX, int? targetY, string button, int count) {
        POINT pt = new POINT();
        Exception err = null;
        Thread t = new Thread(() => {
            IntPtr hDesk = OpenDesktop("default", 0, false, 0x01FF);
            if (hDesk != IntPtr.Zero) {
                SetThreadDesktop(hDesk);
            }
            try {
                if (targetX.HasValue && targetY.HasValue) {
                    SetCursorPos(targetX.Value, targetY.Value);
                    Thread.Sleep(20);
                }
                GetCursorPos(out pt);

                uint down = MOUSEEVENTF_LEFTDOWN;
                uint up = MOUSEEVENTF_LEFTUP;
                if (button != null) {
                    string b = button.ToLowerInvariant();
                    if (b == "right") {
                        down = MOUSEEVENTF_RIGHTDOWN;
                        up = MOUSEEVENTF_RIGHTUP;
                    } else if (b == "middle") {
                        down = MOUSEEVENTF_MIDDLEDOWN;
                        up = MOUSEEVENTF_MIDDLEUP;
                    }
                }

                int clicks = Math.Max(1, count);
                for (int i = 0; i < clicks; i++) {
                    mouse_event(down, 0, 0, 0, UIntPtr.Zero);
                    Thread.Sleep(30);
                    mouse_event(up, 0, 0, 0, UIntPtr.Zero);
                    if (i < clicks - 1) {
                        Thread.Sleep(60);
                    }
                }
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

$finalPos = [Win32MouseClicker]::Click($X, $Y, $Button, $ClickCount)
Write-Output "CLICK_RESULT:{`"ok`":true,`"x`":$($finalPos.X),`"y`":$($finalPos.Y),`"button`":`"$Button`",`"clickCount`":$ClickCount}"
