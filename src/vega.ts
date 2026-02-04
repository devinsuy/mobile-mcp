import { execSync } from "child_process";
import { Button, GetLogsOptions, GetNetworkRequestsOptions, InstalledApp, LogEntry, NetworkRequest, Orientation, ReloadOptions, Robot, ScreenElement, ScreenSize, SwipeDirection } from "./robot";

/**
 * VegaRobot - Robot implementation for Amazon VegaOS (Fire TV) devices
 *
 * Uses a combination of:
 * - vega CLI commands for app management
 * - ADB for input and device interaction
 * - QEMU QMP for screenshots (with limitations - see getScreenshot)
 */
export class VegaRobot implements Robot {
	private deviceId: string;
	private vegaEnvPath: string;
	private qmpSocketPath: string;

	public constructor(deviceId: string) {
		this.deviceId = deviceId;
		// Default vega environment path - can be overridden via env var
		this.vegaEnvPath = process.env.VEGA_ENV_PATH || `${process.env.HOME}/vega/env`;
		// QMP socket path follows pattern /tmp/qmp-socket-{port}.sock
		const port = this.extractPort(deviceId);
		this.qmpSocketPath = `/tmp/qmp-socket-${port}.sock`;
	}

	private extractPort(deviceId: string): string {
		// deviceId format: "emulator-5554" or just port
		const match = deviceId.match(/(\d+)/);
		return match ? match[1] : "5554";
	}

	private runVegaCommand(args: string[]): string {
		const cmd = `source ${this.vegaEnvPath} && vega ${args.join(" ")}`;
		try {
			return execSync(cmd, {
				shell: "/bin/bash",
				encoding: "utf-8",
				timeout: 30000
			}).trim();
		} catch (error: any) {
			throw new Error(`Vega command failed: ${error.message}`);
		}
	}

	private runAdbCommand(args: string[]): string {
		const cmd = `adb -s ${this.deviceId} ${args.join(" ")}`;
		try {
			return execSync(cmd, {
				encoding: "utf-8",
				timeout: 30000
			}).trim();
		} catch (error: any) {
			throw new Error(`ADB command failed: ${error.message}`);
		}
	}

	private runAdbShell(shellCmd: string): string {
		return this.runAdbCommand(["shell", `"${shellCmd}"`]);
	}

	public async getScreenSize(): Promise<ScreenSize> {
		try {
			// Use VegaOS inputd-cli get_screen_size
			const output = this.runAdbCommand(["shell", "inputd-cli", "get_screen_size"]);
			// Parse output format: "width: 1920, height: 1080" or similar
			const widthMatch = output.match(/width[:\s]+(\d+)/i);
			const heightMatch = output.match(/height[:\s]+(\d+)/i);
			if (widthMatch && heightMatch) {
				return {
					width: parseInt(widthMatch[1], 10),
					height: parseInt(heightMatch[1], 10),
					scale: 1.0
				};
			}
		} catch {
			// Fallback to default TV resolution
		}
		// Default VVD resolution
		return { width: 1920, height: 1080, scale: 1.0 };
	}

	public async getScreenshot(): Promise<Buffer> {
		/**
		 * VegaOS screenshot via emulator console.
		 *
		 * The VVD exposes an emulator console on port 5554 that supports
		 * the `screenrecord screenshot` command. This captures the actual
		 * display output from the Weston compositor.
		 */
		const fs = require("fs");
		const os = require("os");
		const path = require("path");

		// Get auth token
		const authTokenPath = path.join(os.homedir(), ".emulator_console_auth_token");
		let authToken = "";
		try {
			authToken = fs.readFileSync(authTokenPath, "utf-8").trim();
		} catch {
			throw new Error("Cannot read emulator auth token from ~/.emulator_console_auth_token");
		}

		// Create temp directory for screenshot
		const tmpDir = `/tmp/vega_screenshots_${Date.now()}`;
		fs.mkdirSync(tmpDir, { recursive: true });

		try {
			// Send commands to emulator console via nc
			const consolePort = this.extractPort(this.deviceId);
			const commands = `auth ${authToken}\nscreenrecord screenshot ${tmpDir}\nquit\n`;

			execSync(`echo "${commands}" | nc localhost ${consolePort}`, {
				shell: "/bin/bash",
				timeout: 10000
			});

			// Wait for screenshot to be written
			await new Promise(resolve => setTimeout(resolve, 1000));

			// Find the screenshot file (named Screenshot_*.png)
			const files = fs.readdirSync(tmpDir);
			const screenshotFile = files.find((f: string) => f.startsWith("Screenshot_") && f.endsWith(".png"));

			if (screenshotFile) {
				const screenshotPath = path.join(tmpDir, screenshotFile);
				const buffer = fs.readFileSync(screenshotPath);

				// Cleanup
				fs.unlinkSync(screenshotPath);
				fs.rmdirSync(tmpDir);

				return buffer;
			}

			throw new Error("Screenshot file not created");
		} catch (error: any) {
			// Cleanup on error
			try {
				fs.rmdirSync(tmpDir, { recursive: true });
			} catch {}

			throw new Error(`Screenshot failed: ${error.message}`);
		}
	}

	public async listApps(): Promise<InstalledApp[]> {
		try {
			const output = this.runVegaCommand([
				"device", "installed-apps",
				"--device", this.deviceId
			]);

			// Parse output - format is one app per line
			const apps: InstalledApp[] = [];
			const lines = output.split("\n").filter(line => line.trim());

			for (const line of lines) {
				const packageName = line.trim();
				if (packageName && !packageName.startsWith("Package") && !packageName.includes(":")) {
					apps.push({
						appName: packageName,
						packageName: packageName
					});
				}
			}

			return apps;
		} catch (error) {
			// Fallback to running apps if installed-apps fails
			const output = this.runVegaCommand([
				"device", "running-apps",
				"--device", this.deviceId
			]);

			return output.split("\n")
				.filter(line => line.trim())
				.map(line => ({
					appName: line.trim(),
					packageName: line.trim()
				}));
		}
	}

	public async launchApp(packageName: string): Promise<void> {
		this.runVegaCommand([
			"device", "launch-app",
			"--device", this.deviceId,
			"-a", packageName
		]);
	}

	public async terminateApp(packageName: string): Promise<void> {
		this.runVegaCommand([
			"device", "terminate-app",
			"--device", this.deviceId,
			"-a", packageName
		]);
	}

	public async installApp(path: string): Promise<void> {
		this.runVegaCommand([
			"device", "install-app",
			"--device", this.deviceId,
			"-p", path
		]);
	}

	public async uninstallApp(bundleId: string): Promise<void> {
		this.runVegaCommand([
			"device", "uninstall-app",
			"--device", this.deviceId,
			"-a", bundleId
		]);
	}

	public async openUrl(url: string): Promise<void> {
		// VegaOS uses am start for URLs via ADB
		this.runAdbCommand([
			"shell", "am", "start",
			"-a", "android.intent.action.VIEW",
			"-d", `"${url}"`
		]);
	}

	public async sendKeys(text: string): Promise<void> {
		// Use VegaOS inputd-cli send_text command
		// Escape special characters for shell
		const escaped = text.replace(/"/g, '\\"');
		this.runAdbCommand(["shell", "inputd-cli", "send_text", `"${escaped}"`]);
	}

	public async pressButton(button: Button): Promise<void> {
		// Map buttons to VegaOS inputd-cli key names
		const keyNameMap: Record<string, string> = {
			"HOME": "KEY_HOMEPAGE",
			"BACK": "KEY_BACK",
			"DPAD_UP": "KEY_UP",
			"DPAD_DOWN": "KEY_DOWN",
			"DPAD_LEFT": "KEY_LEFT",
			"DPAD_RIGHT": "KEY_RIGHT",
			"DPAD_CENTER": "KEY_SELECT",
			"ENTER": "KEY_ENTER",
			"VOLUME_UP": "KEY_VOLUMEUP",
			"VOLUME_DOWN": "KEY_VOLUMEDOWN",
			"MENU": "KEY_MENU",
			"PLAY_PAUSE": "KEY_PLAYPAUSE",
			"MEDIA_PLAY_PAUSE": "KEY_PLAYPAUSE",
			"MEDIA_PLAY": "KEY_PLAY",
			"MEDIA_PAUSE": "KEY_PAUSE",
			"MEDIA_NEXT": "KEY_NEXTSONG",
			"MEDIA_PREVIOUS": "KEY_PREVIOUSSONG",
			"MEDIA_REWIND": "KEY_REWIND",
			"MEDIA_FAST_FORWARD": "KEY_FASTFORWARD",
		};

		const keyName = keyNameMap[button.toUpperCase()];
		if (keyName) {
			this.runAdbCommand(["shell", "inputd-cli", "button_press", keyName]);
		} else {
			throw new Error(`Unknown button: ${button}. Available buttons: ${Object.keys(keyNameMap).join(", ")}`);
		}
	}

	public async tap(x: number, y: number): Promise<void> {
		// Use VegaOS inputd-cli touch command
		this.runAdbCommand(["shell", "inputd-cli", "touch", x.toString(), y.toString()]);
	}

	public async doubleTap(x: number, y: number): Promise<void> {
		await this.tap(x, y);
		await new Promise(resolve => setTimeout(resolve, 100));
		await this.tap(x, y);
	}

	public async longPress(x: number, y: number, duration: number): Promise<void> {
		// Use VegaOS inputd-cli touch with long press option
		this.runAdbCommand([
			"shell", "inputd-cli", "touch",
			x.toString(), y.toString(),
			"--holdDuration", duration.toString()
		]);
	}

	public async swipe(direction: SwipeDirection): Promise<void> {
		const screenSize = await this.getScreenSize();
		const centerX = Math.floor(screenSize.width / 2);
		const centerY = Math.floor(screenSize.height / 2);
		await this.swipeFromCoordinate(centerX, centerY, direction);
	}

	public async swipeFromCoordinate(x: number, y: number, direction: SwipeDirection, distance?: number): Promise<void> {
		const swipeDistance = distance || 400;

		// Use VegaOS inputd-cli gesture_swipe_* commands
		const gestureCommands: Record<SwipeDirection, string> = {
			"up": "gesture_swipe_up",
			"down": "gesture_swipe_down",
			"left": "gesture_swipe_left",
			"right": "gesture_swipe_right",
		};

		const gesture = gestureCommands[direction];
		this.runAdbCommand([
			"shell", "inputd-cli", gesture,
			x.toString(), y.toString(),
			"--distance", swipeDistance.toString()
		]);
	}

	public async getElementsOnScreen(): Promise<ScreenElement[]> {
		/**
		 * VegaOS element detection via app-side devtools + loggingctl.
		 *
		 * The React Native app outputs element info to logs with special markers:
		 * __MCP_ELEMENTS_START__[...]__MCP_ELEMENTS_END__
		 *
		 * VegaOS uses loggingctl instead of Android's logcat.
		 * See hornet-app/vega/src/devtools/ReactotronConfig.ts for the app-side implementation.
		 */
		try {
			// Get recent log entries using VegaOS loggingctl
			const output = this.runAdbCommand([
				"shell", "loggingctl", "log", "-v", "com.amzn.music.hornettv"
			]);

			// Find the most recent element dump between markers
			const startMarker = "__MCP_ELEMENTS_START__";
			const endMarker = "__MCP_ELEMENTS_END__";

			const lines = output.split("\n");
			let latestJson = "";

			for (const line of lines) {
				const startIdx = line.indexOf(startMarker);
				const endIdx = line.indexOf(endMarker);
				if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
					latestJson = line.substring(startIdx + startMarker.length, endIdx);
				}
			}

			if (latestJson && latestJson.startsWith("[")) {
				const elements = JSON.parse(latestJson);
				return elements.map((el: any) => ({
					type: el.type || "View",
					text: el.text,
					label: el.accessibilityLabel,
					name: el.testID,
					identifier: el.testID,
					focused: el.focused || false,
					rect: {
						x: el.bounds?.x || 0,
						y: el.bounds?.y || 0,
						width: el.bounds?.width || 0,
						height: el.bounds?.height || 0
					}
				}));
			}
		} catch {
			// Logcat parsing failed - app may not have devtools enabled
		}

		// Fallback: Return empty array with guidance
		console.warn(
			"VegaOS element detection requires app-side devtools. " +
			"Ensure the Vega app is built in DEV mode with devtools initialized."
		);
		return [];
	}

	public async setOrientation(orientation: Orientation): Promise<void> {
		// VegaOS/Fire TV typically runs in landscape
		// This is usually a no-op for TV devices
		const orientationValue = orientation === "landscape" ? 1 : 0;
		try {
			this.runAdbCommand([
				"shell", "settings", "put", "system",
				"user_rotation", orientationValue.toString()
			]);
		} catch {
			// Orientation change may not be supported on all VegaOS devices
		}
	}

	public async getOrientation(): Promise<Orientation> {
		try {
			const output = this.runAdbCommand([
				"shell", "settings", "get", "system", "user_rotation"
			]);
			return output.trim() === "0" ? "portrait" : "landscape";
		} catch {
			// Default to landscape for TV
			return "landscape";
		}
	}

	public async getLogs(options?: GetLogsOptions): Promise<LogEntry[]> {
		/**
		 * Get application logs from VegaOS using loggingctl.
		 *
		 * loggingctl log options:
		 * - -v, --vpkg: Filter by package ID
		 * - -p, --priority: Filter by priority (error, warn, info)
		 * - -o, --output-format: Output format
		 */
		const args = ["shell", "loggingctl", "log"];

		// Filter by package if specified
		if (options?.packageName) {
			args.push("-v", options.packageName);
		}

		// Set output format for easier parsing
		args.push("-o", "short_precise");

		try {
			const output = this.runAdbCommand(args);
			const lines = output.split("\n");
			const entries: LogEntry[] = [];

			// Parse log lines
			// Format: "Jan 22 06:46:38.115031 hostname package[pid]: LEVEL tag: message"
			const logLineRegex = /^(\w+\s+\d+\s+[\d:.]+)\s+\S+\s+([^[]+)\[(\d+)\]:\s*(\w+)?\s*([^:]+)?:\s*(.*)$/;
			const jsLogRegex = /\[KeplerScript-JavaScript\]\s*(.*)/;

			const maxLines = options?.lines || 50;
			let count = 0;

			// Process from end to get most recent logs
			for (let i = lines.length - 1; i >= 0 && count < maxLines; i--) {
				const line = lines[i].trim();
				if (!line) {continue;}

				// Skip MCP element dumps (noisy)
				if (line.includes("__MCP_ELEMENTS_START__")) {continue;}

				const match = line.match(logLineRegex);
				if (match) {
					const [, timestamp, , , levelStr, tag, rawMessage] = match;

					// Determine log level
					let level: LogEntry["level"] = "info";
					const levelLower = (levelStr || "").toLowerCase();
					if (levelLower.includes("err") || line.includes(".err ")) {
						level = "error";
					} else if (levelLower.includes("warn") || line.includes(".warning ")) {
						level = "warn";
					} else if (levelLower.includes("debug")) {
						level = "debug";
					}

					// Filter by level if specified
					if (options?.level && options.level !== "all") {
						if (options.level === "error" && level !== "error") {continue;}
						if (options.level === "warn" && level !== "error" && level !== "warn") {continue;}
					}

					// Extract JS log message if present
					let message = rawMessage || line;
					const jsMatch = message.match(jsLogRegex);
					if (jsMatch) {
						message = jsMatch[1];
					}

					// Apply filter regex if specified
					if (options?.filter) {
						try {
							const filterRegex = new RegExp(options.filter, "i");
							if (!filterRegex.test(message)) {continue;}
						} catch {
							// Invalid regex, skip filtering
						}
					}

					entries.unshift({
						timestamp: timestamp || new Date().toISOString(),
						level,
						tag: tag?.trim(),
						message: message.trim()
					});
					count++;
				}
			}

			return entries;
		} catch (error: any) {
			throw new Error(`Failed to get logs: ${error.message}`);
		}
	}

	public async reloadApp(options?: ReloadOptions): Promise<void> {
		/**
		 * Trigger Metro bundler to reload the JavaScript bundle.
		 *
		 * This calls the Metro /reload endpoint which causes the app
		 * to fetch and execute the updated JS bundle without a full restart.
		 */
		const port = options?.metroPort || 8081;
		const url = `http://localhost:${port}/reload`;

		try {
			const response = await fetch(url, { method: "POST" });
			if (!response.ok) {
				throw new Error(`Metro returned status ${response.status}`);
			}
		} catch (error: any) {
			if (error.code === "ECONNREFUSED") {
				throw new Error(`Metro bundler is not running on port ${port}. Start it with 'npm start' in the app directory.`);
			}
			throw new Error(`Failed to reload app: ${error.message}`);
		}
	}

	public async getNetworkRequests(options?: GetNetworkRequestsOptions): Promise<NetworkRequest[]> {
		/**
		 * Get network requests from app logs.
		 *
		 * The app uses NetworkLogger to output requests with markers:
		 * __MCP_NETWORK_START__<json>__MCP_NETWORK_END__
		 */
		const args = ["shell", "loggingctl", "log"];

		// Filter by package if specified
		if (options?.packageName) {
			args.push("-v", options.packageName);
		}

		args.push("-o", "short_precise");

		try {
			const output = this.runAdbCommand(args);
			const lines = output.split("\n");
			const requests: NetworkRequest[] = [];

			const startMarker = "__MCP_NETWORK_START__";
			const endMarker = "__MCP_NETWORK_END__";
			const maxCount = options?.count || 20;

			// Process from end to get most recent
			for (let i = lines.length - 1; i >= 0 && requests.length < maxCount; i--) {
				const line = lines[i];
				const startIdx = line.indexOf(startMarker);
				const endIdx = line.indexOf(endMarker);

				if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
					try {
						const json = line.substring(startIdx + startMarker.length, endIdx);
						const entry = JSON.parse(json) as NetworkRequest;

						// Apply URL filter if specified
						if (options?.filterUrl) {
							try {
								const regex = new RegExp(options.filterUrl, "i");
								if (!regex.test(entry.url)) {continue;}
							} catch {
								// Invalid regex, skip filtering
							}
						}

						requests.unshift(entry);
					} catch {
						// Skip malformed JSON
					}
				}
			}

			return requests;
		} catch (error: any) {
			throw new Error(`Failed to get network requests: ${error.message}`);
		}
	}
}
