# clean-restart.ps1 — 杀掉所有 cat-cafe 相关进程并重启
# 用法: powershell -File scripts/clean-restart.ps1

Write-Host "=== Cat Cafe Clean Restart ===" -ForegroundColor Cyan

# Step 1: Kill known processes on our ports
$ports = @(3003, 3004, 9879, 9464)
foreach ($port in $ports) {
    $procIds = (netstat -aon 2>$null | Select-String ":$port\s+.*LISTENING" | ForEach-Object { ($_ -split '\s+')[-1] } | Sort-Object -Unique)
    foreach ($procId in $procIds) {
        if ($procId -and $procId -ne '0') {
            Write-Host "Killing PID $procId (port $port)..." -ForegroundColor Yellow
            taskkill /PID $procId /F 2>$null | Out-Null
        }
    }
}

# Also kill any stray python TTS processes
$pythonProcs = Get-Process python -ErrorAction SilentlyContinue
foreach ($proc in $pythonProcs) {
    Write-Host "Killing Python PID $($proc.Id)..." -ForegroundColor Yellow
    taskkill /PID $proc.Id /F 2>$null | Out-Null
}

# Step 2: Wait for ports to be released
Start-Sleep -Seconds 2

# Step 3: Verify ports are free
$stillListening = (netstat -aon 2>$null | Select-String ":(3003|3004|9879)\s+.*LISTENING")
if ($stillListening) {
    Write-Host "WARNING: Some ports still in use:" -ForegroundColor Red
    $stillListening | ForEach-Object { Write-Host "  $_" }
    Write-Host "Waiting 5 more seconds and force-killing..." -ForegroundColor Yellow
    Start-Sleep -Seconds 5
    # Force kill anything still on those ports
    foreach ($port in @(3003, 3004, 9879)) {
        $remaining = (netstat -aon 2>$null | Select-String ":$port\s+.*LISTENING" | ForEach-Object { ($_ -split '\s+')[-1] } | Sort-Object -Unique)
        foreach ($procId in $remaining) {
            if ($procId -and $procId -ne '0') {
                Write-Host "Force killing PID $procId (port $port)..." -ForegroundColor Red
                taskkill /PID $procId /F /T 2>$null | Out-Null
            }
        }
    }
    Start-Sleep -Seconds 1
}

# Step 4: Final check
$finalCheck = (netstat -aon 2>$null | Select-String ":(3003|3004|9879)\s+.*LISTENING")
if ($finalCheck) {
    Write-Host "ERROR: Could not free all ports. Manual cleanup needed." -ForegroundColor Red
    $finalCheck | ForEach-Object { Write-Host "  $_" }
} else {
    Write-Host "All processes killed. Ports are free." -ForegroundColor Green
}

Write-Host "Now run your start script: .\scripts\start-windows.ps1" -ForegroundColor Cyan
