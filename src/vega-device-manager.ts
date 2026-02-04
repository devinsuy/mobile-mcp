import { execSync } from "child_process";
import { trace } from "./logger";

export interface VegaDevice {
	id: string;
	name: string;
	platform: "vega";
	type: "virtual" | "real";
	state: "booted" | "offline";
}

/**
 * VegaDeviceManager - Discovers and manages VegaOS devices
 *
 * Uses the vega CLI to discover devices (both VVD and physical Fire TV devices)
 */
export class VegaDeviceManager {
	private vegaEnvPath: string;
	private adbPath: string;

	constructor() {
		this.vegaEnvPath = process.env.VEGA_ENV_PATH || `${process.env.HOME}/vega/env`;
		this.adbPath = this.findAdb();
		trace(`VegaDeviceManager initialized: vegaEnvPath=${this.vegaEnvPath}, adbPath=${this.adbPath}`);
	}

	private findAdb(): string {
		// Common adb locations
		const paths = [
			process.env.ANDROID_HOME && `${process.env.ANDROID_HOME}/platform-tools/adb`,
			`${process.env.HOME}/Library/Android/sdk/platform-tools/adb`,
			"/usr/local/bin/adb",
			"adb" // fallback to PATH
		].filter(Boolean) as string[];

		for (const adbPath of paths) {
			try {
				execSync(`${adbPath} version`, { encoding: "utf-8", timeout: 2000, stdio: "pipe" });
				return adbPath;
			} catch {
				// Try next path
			}
		}
		return "adb"; // fallback
	}

	private isVegaInstalled(): boolean {
		try {
			execSync(`source ${this.vegaEnvPath} && which vega`, {
				shell: "/bin/bash",
				encoding: "utf-8",
				timeout: 5000
			});
			return true;
		} catch {
			return false;
		}
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

	/**
	 * Get list of available Vega devices
	 */
	public getDevices(): VegaDevice[] {
		if (!this.isVegaInstalled()) {
			return [];
		}

		const devices: VegaDevice[] = [];

		try {
			const output = this.runVegaCommand(["device", "list"]);

			// Parse device list output
			// Format: "VirtualDevice : tv - aarch64 - OS - amazon-51388c2526956395"
			// or "Found the following device:" (header to skip)
			const lines = output.split("\n").filter(line => line.trim());

			for (const line of lines) {
				// Skip header lines
				if (line.toLowerCase().includes("no devices") ||
					line.toLowerCase().includes("found the following") ||
					line.toLowerCase().includes("serial") ||
					line.startsWith("-")) {
					continue;
				}

				// Parse "VirtualDevice : tv - aarch64 - OS - amazon-xxx" format
				const vegaMatch = line.match(/VirtualDevice\s*:\s*.*-\s*(\S+)$/);
				if (vegaMatch) {
					// VVD detected - use emulator-5554 as the standard device ID
					// since that's what ADB reports and what we use for commands
					continue; // We'll pick this up from ADB instead
				}

				// Parse standard device line - format: "emulator-5554" or "serial_number"
				// Device IDs are alphanumeric with possible dashes/underscores, no colons
				const parts = line.trim().split(/\s+/);
				if (parts.length >= 1) {
					const deviceId = parts[0];
					// Skip if it looks like a label, header word, or debug output
					if (deviceId.toLowerCase() === "virtualdevice" ||
						deviceId.toLowerCase() === "found" ||
						deviceId.toLowerCase() === "debug:" ||
						deviceId.toLowerCase().startsWith("debug") ||
						deviceId.includes(":") ||  // Skip debug output like "winston:create-logger:"
						deviceId.length < 3 ||
						!/^[a-zA-Z0-9\-_]+$/.test(deviceId)) {  // Must be alphanumeric with dashes/underscores
						continue;
					}
					const isEmulator = deviceId.includes("emulator");

					devices.push({
						id: deviceId,
						name: isEmulator ? `Vega Virtual Device (${deviceId})` : `Fire TV (${deviceId})`,
						platform: "vega",
						type: isEmulator ? "virtual" : "real",
						state: "booted"
					});
				}
			}
		} catch (error) {
			// Silent fail - no devices available
		}

		// Also check for VVD via ADB
		try {
			trace(`Checking ADB devices with: ${this.adbPath} devices`);
			const adbOutput = execSync(`${this.adbPath} devices`, {
				encoding: "utf-8",
				timeout: 5000
			});
			trace(`ADB devices output: ${adbOutput}`);

			const adbLines = adbOutput.split("\n").filter(line =>
				line.includes("emulator") && line.includes("device")
			);

			for (const line of adbLines) {
				const match = line.match(/(emulator-\d+)/);
				if (match) {
					const deviceId = match[1];
					// Check if we already have this device
					if (!devices.find(d => d.id === deviceId)) {
						// Verify it's a VegaOS device by checking for vega-specific process
						try {
							const psOutput = execSync(`${this.adbPath} -s ${deviceId} shell "ps | grep weston || echo vega"`, {
								encoding: "utf-8",
								timeout: 5000
							});
							trace(`Vega device check for ${deviceId}: ${psOutput.trim()}`);
							if (psOutput.includes("weston") || psOutput.includes("vega")) {
								devices.push({
									id: deviceId,
									name: `Vega Virtual Device (${deviceId})`,
									platform: "vega",
									type: "virtual",
									state: "booted"
								});
							}
						} catch (e: any) {
							trace(`Failed to verify device ${deviceId}: ${e.message}`);
						}
					}
				}
			}
		} catch (e: any) {
			trace(`ADB device listing failed: ${e.message}`);
		}

		return devices;
	}

	/**
	 * Check if a device ID belongs to a Vega device
	 */
	public isVegaDevice(deviceId: string): boolean {
		const devices = this.getDevices();
		return devices.some(d => d.id === deviceId);
	}

	/**
	 * Get VVD status
	 */
	public getVVDStatus(): { running: boolean; deviceId?: string } {
		if (!this.isVegaInstalled()) {
			return { running: false };
		}

		try {
			const output = this.runVegaCommand(["virtual-device", "status"]);
			if (output.toLowerCase().includes("running")) {
				// Extract device ID from device list
				const devices = this.getDevices();
				const vvd = devices.find(d => d.type === "virtual");
				return { running: true, deviceId: vvd?.id };
			}
		} catch {
			// VVD not running
		}

		return { running: false };
	}

	/**
	 * Start VVD
	 */
	public startVVD(): boolean {
		try {
			this.runVegaCommand(["virtual-device", "start"]);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Stop VVD
	 */
	public stopVVD(): boolean {
		try {
			this.runVegaCommand(["virtual-device", "stop"]);
			return true;
		} catch {
			return false;
		}
	}
}

// Singleton instance
let _vegaDeviceManager: VegaDeviceManager | null = null;

export function getVegaDeviceManager(): VegaDeviceManager {
	if (!_vegaDeviceManager) {
		_vegaDeviceManager = new VegaDeviceManager();
	}
	return _vegaDeviceManager;
}
