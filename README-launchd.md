# PolyWeather launchd setup (macOS crash recovery -- D-03)

Keep the scheduler alive across reboots and crashes with a user LaunchAgent.

## 1. Create the plist

Save as `~/Library/LaunchAgents/com.polyweather.scheduler.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.polyweather.scheduler</string>
  <key>WorkingDirectory</key>
  <string>/Users/jorgeperozo/Desktop/PolyWeather</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/uv</string>
    <string>run</string>
    <string>python</string>
    <string>-m</string>
    <string>polyweather.scheduler</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/polyweather-scheduler.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/polyweather-scheduler.stderr.log</string>
</dict>
</plist>
```

Adjust the path to `uv` if it's not `/opt/homebrew/bin/uv` (verify with `which uv`).

## 2. Load and start

```bash
launchctl load ~/Library/LaunchAgents/com.polyweather.scheduler.plist
launchctl start com.polyweather.scheduler
```

## 3. Verify

```bash
launchctl list | grep polyweather
tail -f /tmp/polyweather-scheduler.stderr.log   # structlog output goes here
```

## 4. Unload (stop the daemon)

```bash
launchctl unload ~/Library/LaunchAgents/com.polyweather.scheduler.plist
```

`KeepAlive=true` restarts the daemon automatically on crash. Misfire-grace-time of 300s handles short sleeps; longer sleeps drop the missed cron and resume at the next scheduled run, which is fine for daily-resolution markets.
