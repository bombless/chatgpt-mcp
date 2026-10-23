param(
    [Nullable[int]]$X,
    [Nullable[int]]$Y,
    [string]$Direction = 'down',
    [int]$Amount = 1
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Threading;
using System.Runtime.InteropServices;

public class Win32MouseScroller {
    [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr OpenDesktop(string lpszDesktop, int dwFlags, bool fInherit, uint dwDesiredAccess);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetThreadDesktop(IntPtr hDesktop);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool CloseDesktop(IntPtr hDesktop);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool GetCursorPos(out POINT lpPoint);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll", SetLastError = true)] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    public const uint MOUSEEVENTF_WHEEL  = 0x0800;
    public const uint MOUSEEVENTF_HWHEEL = 0x1000;
    public const int WHEEL_DELTA = 120;

    public static POINT Scroll(int? targetX, int? targetY, string direction, int amount) {
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

                string dir = (direction ?? "down").ToLowerInvariant();
                uint flag = MOUSEEVENTF_WHEEL;
                int delta = -WHEEL_DELTA; // default down

                if (dir == "up") {
                    flag = MOUSEEVENTF_WHEEL;
                    delta = WHEEL_DELTA;
                } else if (dir == "down") {
                    flag = MOUSEEVENTF_WHEEL;
                    delta = -WHEEL_DELTA;
                } else if (dir == "left") {
                    flag = MOUSEEVENTF_HWHEEL;
                    delta = -WHEEL_DELTA;
                } else if (dir == "right") {
                    flag = MOUSEEVENTF_HWHEEL;
                    delta = WHEEL_DELTA;
                }

                int steps = Math.Max(1, amount);
                for (int i = 0; i < steps; i++) {
                    mouse_event(flag, 0, 0, unchecked((uint)delta), UIntPtr.Zero);
                    if (i < steps - 1) {
                        Thread.Sleep(20);
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

$finalPos = [Win32MouseScroller]::Scroll($X, $Y, $Direction, $Amount)
Write-Output "SCROLL_RESULT:{`"ok`":true,`"x`":$($finalPos.X),`"y`":$($finalPos.Y),`"direction`":`"$Direction`",`"amount`":$Amount}"
