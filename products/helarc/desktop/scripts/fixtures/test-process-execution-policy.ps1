param(
  [Parameter(Mandatory = $true)][uint32]$TargetProcessId,
  [ValidateSet('inspect', 'foreground', 'restore')][string]$Action = 'inspect',
  [uint32]$ControlMask = 0,
  [uint32]$StateMask = 0
)
$ErrorActionPreference = 'Stop'
$self = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
if ($self.ParentProcessId -ne $TargetProcessId -or (Get-Process -Id $TargetProcessId).ProcessName -ne 'node') {
  throw 'Only the directly owning Node test process can select its execution policy.'
}
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class TestProcessPolicy {
  [StructLayout(LayoutKind.Sequential)]
  public struct PowerState { public uint Version, ControlMask, StateMask; }
  [DllImport("kernel32.dll", ExactSpelling=true, SetLastError=true)]
  private static extern SafeProcessHandle OpenProcess(uint access, int inherit, uint id);
  [DllImport("kernel32.dll", ExactSpelling=true, SetLastError=true)]
  private static extern int GetProcessInformation(SafeProcessHandle process, int kind, ref PowerState state, uint size);
  [DllImport("kernel32.dll", ExactSpelling=true, SetLastError=true)]
  private static extern int SetProcessInformation(SafeProcessHandle process, int kind, ref PowerState state, uint size);
  private static PowerState Read(SafeProcessHandle process) {
    var state = new PowerState { Version = 1 };
    if (GetProcessInformation(process, 4, ref state, 12) == 0)
      throw new Win32Exception(Marshal.GetLastWin32Error());
    return state;
  }
  public static PowerState[] Apply(uint id, string action, uint control, uint state) {
    using (var process = OpenProcess(action == "inspect" ? 0x1000u : 0x1200u, 0, id)) {
      if (process.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      var before = Read(process);
      if (action != "inspect") {
        var next = new PowerState { Version = 1,
          ControlMask = action == "foreground" ? before.ControlMask | 1u : control,
          StateMask = action == "foreground" ? before.StateMask & ~1u : state };
        if (SetProcessInformation(process, 4, ref next, 12) == 0)
          throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      return new PowerState[] { before, Read(process) };
    }
  }
}
'@
$states = [TestProcessPolicy]::Apply($TargetProcessId, $Action, $ControlMask, $StateMask)
$process = Get-Process -Id $TargetProcessId
[pscustomobject]@{
  pid = $TargetProcessId
  action = $Action
  priority = $process.PriorityClass.ToString()
  affinity = $process.ProcessorAffinity.ToInt64().ToString('X')
  before = $states[0]
  after = $states[1]
} | ConvertTo-Json -Depth 3 -Compress
