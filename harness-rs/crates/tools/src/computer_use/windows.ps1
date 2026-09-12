# This script is fixed source. Model data arrives as base64 JSON in an env var;
# it is never parsed as PowerShell, SendKeys syntax, or a C# source fragment.
$ErrorActionPreference = 'Stop'
$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:WORLDBASE_COMPUTER_INPUT)) | ConvertFrom-Json
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WBDesktop {
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 [DllImport("user32.dll")] public static extern int GetSystemMetrics(int n);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint n, INPUT[] input,int size);
 [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public DATA data; }
 [StructLayout(LayoutKind.Explicit)] struct DATA { [FieldOffset(0)] public MOUSE mouse; [FieldOffset(0)] public KEY key; }
 [StructLayout(LayoutKind.Sequential)] struct MOUSE { public int dx,dy; public uint data,flags,time; public UIntPtr extra; }
 [StructLayout(LayoutKind.Sequential)] struct KEY { public ushort vk,scan; public uint flags,time; public UIntPtr extra; }
 static void Send(INPUT[] input) { if(SendInput((uint)input.Length,input,Marshal.SizeOf(typeof(INPUT)))!=input.Length) throw new Exception("Input failed (possibly UIPI / secure desktop)"); }
 public static void Mouse(uint flags,int data) { INPUT i=new INPUT();i.type=0;i.data.mouse.flags=flags;i.data.mouse.data=unchecked((uint)data);Send(new[]{i}); }
 static void Key(ushort vk,ushort scan,uint flags) { INPUT d=new INPUT();d.type=1;d.data.key.vk=vk;d.data.key.scan=scan;d.data.key.flags=flags; INPUT u=d;u.data.key.flags=flags|2;Send(new[]{d,u}); }
 public static void Text(string value) { foreach(char c in value) Key(0,c,4); }
 public static void Press(ushort vk) { Key(vk,0,0); }
}
'@
[void][WBDesktop]::SetProcessDPIAware()
$g = @{x=0;y=0;width=[WBDesktop]::GetSystemMetrics(0);height=[WBDesktop]::GetSystemMetrics(1)}
$focus = [WBDesktop]::GetForegroundWindow().ToInt64().ToString()
if ($p.mode -eq 'geometry') { $g | ConvertTo-Json -Compress; exit }
if ($p.mode -eq 'capture') {
 $bitmap = New-Object System.Drawing.Bitmap($g.width,$g.height)
 $graphics = [Drawing.Graphics]::FromImage($bitmap)
 $stream = New-Object IO.MemoryStream
 try {
  $graphics.CopyFromScreen(0,0,0,0,$bitmap.Size)
  $bitmap.Save($stream,[Drawing.Imaging.ImageFormat]::Png)
  if ([WBDesktop]::GetForegroundWindow().ToInt64().ToString() -ne $focus) { throw 'Focus changed during capture' }
  @{geometry=$g;focus=$focus;image=[Convert]::ToBase64String($stream.ToArray())} | ConvertTo-Json -Compress
 } finally { $graphics.Dispose();$bitmap.Dispose();$stream.Dispose() }
 exit
}
if ($p.mode -ne 'action') { throw 'Unknown desktop mode' }
$a=$p.input
if (($a.action -eq 'type' -or $a.action -eq 'key') -and $focus -ne $p.focus) { throw 'Focus changed; observe again' }
switch ($a.action) {
 'click' { if(-not [WBDesktop]::SetCursorPos($a.x,$a.y)) {throw 'Cursor failed'}; [WBDesktop]::Mouse(2,0);[WBDesktop]::Mouse(4,0) }
 'double_click' { if(-not [WBDesktop]::SetCursorPos($a.x,$a.y)) {throw 'Cursor failed'}; for($i=0;$i -lt 2;$i++) {[WBDesktop]::Mouse(2,0);[WBDesktop]::Mouse(4,0)} }
 'scroll' { if(-not [WBDesktop]::SetCursorPos($a.x,$a.y)) {throw 'Cursor failed'}; [WBDesktop]::Mouse(2048,([int]$a.delta_y*120)) }
 'type' { [WBDesktop]::Text([string]$a.text) }
 'key' {
  $keys=@{Enter=13;Tab=9;Escape=27;Backspace=8;Delete=46;Left=37;Right=39;Up=38;Down=40;Space=32;Home=36;End=35;PageUp=33;PageDown=34}
  if (-not $keys.ContainsKey([string]$a.key)) { throw 'Unsupported key' }
  [WBDesktop]::Press($keys[[string]$a.key])
 }
 default { throw 'Unsupported input action' }
}
'{"ok":true}'
