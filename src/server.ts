import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";

import { error, trace } from "./logger";
import { AndroidRobot, AndroidDeviceManager } from "./android";
import { ActionableError, Robot } from "./robot";
import { IosManager, IosRobot } from "./ios";
import { PNG } from "./png";
import { isScalingAvailable, Image } from "./image-utils";
import { Mobilecli } from "./mobilecli";
import { MobileDevice } from "./mobile-device";
import { VegaRobot } from "./vega";
import { getVegaDeviceManager } from "./vega-device-manager";

interface MobilecliDevice {
	id: string;
	name: string;
	platform: "android" | "ios" | "vega";
	type: "real" | "emulator" | "simulator" | "virtual";
	version: string;
	state: "online" | "offline";
}

interface MobilecliDevicesResponse {
	devices: MobilecliDevice[];
}

export const getAgentVersion = (): string => {
	const json = require("../package.json");
	return json.version;
};

export const createMcpServer = (): McpServer => {

	const server = new McpServer({
		name: "mobile-mcp",
		version: getAgentVersion(),
	});

	// an empty object to satisfy windsurf
	const noParams = z.object({});

	const getClientName = (): string => {
		try {
			const clientInfo = server.server.getClientVersion();
			const clientName = clientInfo?.name || "unknown";
			return clientName;
		} catch (error: any) {
			return "unknown";
		}
	};

	type ZodSchemaShape = Record<string, z.ZodType>;

	interface ToolAnnotations {
		readOnlyHint?: boolean;
		destructiveHint?: boolean;
	}

	const tool = (name: string, title: string, description: string, paramsSchema: ZodSchemaShape, annotations: ToolAnnotations, cb: (args: any) => Promise<string>) => {
		server.registerTool(name, {
			title,
			description,
			inputSchema: paramsSchema,
			annotations,
		}, (async (args: any, _extra: any) => {
			try {
				trace(`Invoking ${name} with args: ${JSON.stringify(args)}`);
				const start = +new Date();
				const response = await cb(args);
				const duration = +new Date() - start;
				trace(`=> ${response}`);
				posthog("tool_invoked", { "ToolName": name, "Duration": duration }).then();
				return {
					content: [{ type: "text", text: response }],
				};
			} catch (error: any) {
				posthog("tool_failed", { "ToolName": name }).then();
				if (error instanceof ActionableError) {
					return {
						content: [{ type: "text", text: `${error.message}. Please fix the issue and try again.` }],
					};
				} else {
					// a real exception
					trace(`Tool '${description}' failed: ${error.message} stack: ${error.stack}`);
					return {
						content: [{ type: "text", text: `Error: ${error.message}` }],
						isError: true,
					};
				}
			}
		}) as any);
	};

	const posthog = async (event: string, properties: Record<string, string | number>) => {
		try {
			const url = "https://us.i.posthog.com/i/v0/e/";
			const api_key = "phc_KHRTZmkDsU7A8EbydEK8s4lJpPoTDyyBhSlwer694cS";
			const name = os.hostname() + process.execPath;
			const distinct_id = crypto.createHash("sha256").update(name).digest("hex");
			const systemProps: any = {
				Platform: os.platform(),
				Product: "mobile-mcp",
				Version: getAgentVersion(),
				NodeVersion: process.version,
			};

			const clientName = getClientName();
			if (clientName !== "unknown") {
				systemProps.AgentName = clientName;
			}

			await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json"
				},
				body: JSON.stringify({
					api_key,
					event,
					properties: {
						...systemProps,
						...properties,
					},
					distinct_id,
				})
			});
		} catch (err: any) {
			// ignore
		}
	};

	const mobilecli = new Mobilecli();
	posthog("launch", {}).then();

	const ensureMobilecliAvailable = (): void => {
		try {
			const version = mobilecli.getVersion();
			if (version.startsWith("failed")) {
				throw new Error("mobilecli version check failed");
			}
		} catch (error: any) {
			throw new ActionableError(`mobilecli is not available or not working properly. Please review the documentation at https://github.com/mobile-next/mobile-mcp/wiki for installation instructions`);
		}
	};

	const getRobotFromDevice = (deviceId: string): Robot => {

		// Check if it's a Vega device first (doesn't require mobilecli)
		const vegaManager = getVegaDeviceManager();
		if (vegaManager.isVegaDevice(deviceId)) {
			return new VegaRobot(deviceId);
		}

		// from now on, we must have mobilecli working
		ensureMobilecliAvailable();

		// Check if it's an iOS device
		const iosManager = new IosManager();
		const iosDevices = iosManager.listDevices();
		const iosDevice = iosDevices.find(d => d.deviceId === deviceId);
		if (iosDevice) {
			return new IosRobot(deviceId);
		}

		// Check if it's an Android device
		const androidManager = new AndroidDeviceManager();
		const androidDevices = androidManager.getConnectedDevices();
		const androidDevice = androidDevices.find(d => d.deviceId === deviceId);
		if (androidDevice) {
			return new AndroidRobot(deviceId);
		}

		// Check if it's a simulator (will later replace all other device types as well)
		const response = mobilecli.getDevices({
			platform: "ios",
			type: "simulator",
			includeOffline: false,
		});

		if (response.status === "ok" && response.data && response.data.devices) {
			for (const device of response.data.devices) {
				if (device.id === deviceId) {
					return new MobileDevice(deviceId);
				}
			}
		}

		throw new ActionableError(`Device "${deviceId}" not found. Use the mobile_list_available_devices tool to see available devices.`);
	};

	tool(
		"mobile_list_available_devices",
		"List Devices",
		"List all available devices. This includes both physical devices and simulators. If there is more than one device returned, you need to let the user select one of them.",
		{
			noParams
		},
		{ readOnlyHint: true },
		async ({}) => {

			const devices: MobilecliDevice[] = [];

			// Get Vega devices first (doesn't require mobilecli)
			try {
				const vegaManager = getVegaDeviceManager();
				const vegaDevices = vegaManager.getDevices();
				for (const device of vegaDevices) {
					devices.push({
						id: device.id,
						name: device.name,
						platform: "vega",
						type: device.type,
						version: "VegaOS",
						state: device.state === "booted" ? "online" : "offline",
					});
				}
			} catch (error: any) {
				// Vega not available, continue
			}

			// from today onward, we must have mobilecli working for Android/iOS
			try {
				ensureMobilecliAvailable();
			} catch (e) {
				// If mobilecli is not available but we have Vega devices, return those
				if (devices.length > 0) {
					const out: MobilecliDevicesResponse = { devices };
					return JSON.stringify(out);
				}
				throw e;
			}

			const iosManager = new IosManager();
			const androidManager = new AndroidDeviceManager();

			// Get Android devices with details
			const androidDevices = androidManager.getConnectedDevicesWithDetails();
			for (const device of androidDevices) {
				devices.push({
					id: device.deviceId,
					name: device.name,
					platform: "android",
					type: "emulator",
					version: device.version,
					state: "online",
				});
			}

			// Get iOS physical devices with details
			try {
				const iosDevices = iosManager.listDevicesWithDetails();
				for (const device of iosDevices) {
					devices.push({
						id: device.deviceId,
						name: device.deviceName,
						platform: "ios",
						type: "real",
						version: device.version,
						state: "online",
					});
				}
			} catch (error: any) {
				// If go-ios is not available, silently skip
			}

			// Get iOS simulators from mobilecli (excluding offline devices)
			const response = mobilecli.getDevices({
				platform: "ios",
				type: "simulator",
				includeOffline: false,
			});
			if (response.status === "ok" && response.data && response.data.devices) {
				for (const device of response.data.devices) {
					devices.push({
						id: device.id,
						name: device.name,
						platform: device.platform,
						type: device.type,
						version: device.version,
						state: "online",
					});
				}
			}

			const out: MobilecliDevicesResponse = { devices };
			return JSON.stringify(out);
		}
	);


	tool(
		"mobile_list_apps",
		"List Apps",
		"List all the installed apps on the device",
		{
			device: z.string().describe("The device identifier to use. Use mobile_list_available_devices to find which devices are available to you.")
		},
		{ readOnlyHint: true },
		async ({ device }) => {
			const robot = getRobotFromDevice(device);
			const result = await robot.listApps();
			return `Found these apps on device: ${result.map(app => `${app.appName} (${app.packageName})`).join(", ")}`;
		}
	);

	tool(
		"mobile_launch_app",
		"Launch App",
		"Launch an app on mobile device. Use this to open a specific app. You can find the package name of the app by calling list_apps_on_device.",
		{
			device: z.string().describe("The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."),
			packageName: z.string().describe("The package name of the app to launch"),
		},
		{ destructiveHint: true },
		async ({ device, packageName }) => {
			const robot = getRobotFromDevice(device);
			await robot.launchApp(packageName);
			return `Launched app ${packageName}`;
		}
	);

	tool(
		"mobile_terminate_app",
		"Terminate App",
		"Stop and terminate an app on mobile device",
		{
			device: z.string().describe("The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."),
			packageName: z.string().describe("The package name of the app to terminate"),
		},
		{ destructiveHint: true },
		async ({ device, packageName }) => {
			const robot = getRobotFromDevice(device);
			await robot.terminateApp(packageName);
			return `Terminated app ${packageName}`;
		}
	);

	tool(
		"mobile_install_app",
		"Install App",
		"Install an app on mobile device",
		{
			device: z.string().describe("The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."),
			path: z.string().describe("The path to the app file to install. For iOS simulators, provide a .zip file or a .app directory. For Android provide an .apk file. For iOS real devices provide an .ipa file. For Vega/Fire TV devices provide a .vpkg file"),
		},
		{ destructiveHint: true },
		async ({ device, path }) => {
			const robot = getRobotFromDevice(device);
			await robot.installApp(path);
			return `Installed app from ${path}`;
		}
	);

	tool(
		"mobile_uninstall_app",
		"Uninstall App",
		"Uninstall an app from mobile device",
		{
			device: z.string().describe("The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."),
			bundle_id: z.string().describe("Bundle identifier (iOS) or package name (Android) of the app to be uninstalled"),
		},
		{ destructiveHint: true },
		async ({ device, bundle_id }) => {
			const robot = getRobotFromDevice(device);
			await robot.uninstallApp(bundle_id);
			return `Uninstalled app ${bundle_id}`;
		}
	);

	tool(
		"mobile_get_screen_size",
		"Get Screen Size",
		"Get the screen size of the mobile device in pixels",
		{
			device: z.string().describe("The device identifier to use. Use mobile_list_available_devices to find which devices are available to you.")
		},
		{ readOnlyHint: true },
		async ({ device }) => {
			const robot = getRobotFromDevice(device);
			const screenSize = await robot.getScreenSize();
			return `Screen size is ${screenSize.width}x${screenSize.height} pixels`;
		}
	);

	tool(
		"mobile_click_on_screen_at_coordinates",
		"Click Screen",
		"Click on the screen at given x,y coordinates. If clicking on an element, use the list_elements_on_screen tool to find the coordinates.",
		{
			device: z.string().describe("The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."),
			x: z.number().describe("The x coordinate to click on the screen, in pixels"),
			y: z.number().describe("The y coordinate to click on the screen, in pixels"),
		},
		{ destructiveHint: true },
		async ({ device, x, y }) => {
			const robot = getRobotFromDevice(device);
			await robot.tap(x, y);
			return `Clicked on screen at coordinates: ${x}, ${y}`;
		}
	);

	tool(
		"mobile_double_tap_on_screen",
		"Double Tap Screen",
		"Double-tap on the screen at given x,y coordinates.",
		{
			device: z.string().describe("The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."),
			x: z.number().describe("The x coordinate to double-tap, in pixels"),
			y: z.number().describe("The y coordinate to double-tap, in pixels"),
		},
		{ destructiveHint: true },
		async ({ device, x, y }) => {
			const robot = getRobotFromDevice(device);
			await robot!.doubleTap(x, y);
			return `Double-tapped on screen at coordinates: ${x}, ${y}`;
		}
	);

	tool(
		"mobile_long_press_on_screen_at_coordinates",
		"Long Press Screen",
		"Long press on the screen at given x,y coordinates. If long pressing on an element, use the list_elements_on_screen tool to find the coordinates.",
		{
			device: z.string().describe("The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."),
			x: z.number().describe("The x coordinate to long press on the screen, in pixels"),
			y: z.number().describe("The y coordinate to long press on the screen, in pixels"),
			duration: z.number().min(1).max(10000).optional().describe("Duration of the long press in milliseconds. Defaults to 500ms."),
		},
		{ destructiveHint: true },
		async ({ device, x, y, duration }) => {
			const robot = getRobotFromDevice(device);
			const pressDuration = duration ?? 500;
			await robot.longPress(x, y, pressDuration);
			return `Long pressed on screen at coordinates: ${x}, ${y} for ${pressDuration}ms`;
		}
	);

	tool(
		"mobile_list_elements_on_screen",
		"List Screen Elements",
		"List elements on screen and their coordinates, with display text or accessibility label. Do not cache this result.",
		{
			device: z.string().describe("The device identifier to use. Use mobile_list_available_devices to find which devices are available to you.")
		},
		{ readOnlyHint: true },
		async ({ device }) => {
			const robot = getRobotFromDevice(device);
			const elements = await robot.getElementsOnScreen();

			const result = elements.map(element => {
				const out: any = {
					type: element.type,
					text: element.text,
					label: element.label,
					name: element.name,
					value: element.value,
					identifier: element.identifier,
					coordinates: {
						x: element.rect.x,
						y: element.rect.y,
						width: element.rect.width,
						height: element.rect.height,
					},
				};

				if (element.focused) {
					out.focused = true;
				}

				return out;
			});

			return `Found these elements on screen: ${JSON.stringify(result)}`;
		}
	);

	tool(
		"mobile_press_button",
		"Press Button",
		"Press a button on device",
		{
			device: z.string().describe("The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."),
			button: z.string().describe("The button to press. Supported buttons: BACK (android/vega), HOME, VOLUME_UP, VOLUME_DOWN, ENTER, DPAD_CENTER (android tv/vega), DPAD_UP (android tv/vega), DPAD_DOWN (android tv/vega), DPAD_LEFT (android tv/vega), DPAD_RIGHT (android tv/vega), PLAY_PAUSE (vega), MEDIA_REWIND (vega), MEDIA_FAST_FORWARD (vega)"),
		},
		{ destructiveHint: true },
		async ({ device, button }) => {
			const robot = getRobotFromDevice(device);
			await robot.pressButton(button);
			return `Pressed the button: ${button}`;
		}
	);

	tool(
		"mobile_open_url",
		"Open URL",
		"Open a URL in browser on device",
		{
			device: z.string().describe("The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."),
			url: z.string().describe("The URL to open"),
		},
		{ destructiveHint: true },
		async ({ device, url }) => {
			const robot = getRobotFromDevice(device);
			await robot.openUrl(url);
			return `Opened URL: ${url}`;
		}
	);

	tool(
		"mobile_swipe_on_screen",
		"Swipe Screen",
		"Swipe on the screen",
		{
			device: z.string().describe("The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."),
			direction: z.enum(["up", "down", "left", "right"]).describe("The direction to swipe"),
			x: z.number().optional().describe("The x coordinate to start the swipe from, in pixels. If not provided, uses center of screen"),
			y: z.number().optional().describe("The y coordinate to start the swipe from, in pixels. If not provided, uses center of screen"),
			distance: z.number().optional().describe("The distance to swipe in pixels. Defaults to 400 pixels for iOS or 30% of screen dimension for Android"),
		},
		{ destructiveHint: true },
		async ({ device, direction, x, y, distance }) => {
			const robot = getRobotFromDevice(device);

			if (x !== undefined && y !== undefined) {
				// Use coordinate-based swipe
				await robot.swipeFromCoordinate(x, y, direction, distance);
				const distanceText = distance ? ` ${distance} pixels` : "";
				return `Swiped ${direction}${distanceText} from coordinates: ${x}, ${y}`;
			} else {
				// Use center-based swipe
				await robot.swipe(direction);
				return `Swiped ${direction} on screen`;
			}
		}
	);

	tool(
		"mobile_type_keys",
		"Type Text",
		"Type text into the focused element",
		{
			device: z.string().describe("The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."),
			text: z.string().describe("The text to type"),
			submit: z.boolean().describe("Whether to submit the text. If true, the text will be submitted as if the user pressed the enter key."),
		},
		{ destructiveHint: true },
		async ({ device, text, submit }) => {
			const robot = getRobotFromDevice(device);
			await robot.sendKeys(text);

			if (submit) {
				await robot.pressButton("ENTER");
			}

			return `Typed text: ${text}`;
		}
	);

	tool(
		"mobile_save_screenshot",
		"Save Screenshot",
		"Save a screenshot of the mobile device to a file",
		{
			device: z.string().describe("The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."),
			saveTo: z.string().describe("The path to save the screenshot to"),
		},
		{ destructiveHint: true },
		async ({ device, saveTo }) => {
			const robot = getRobotFromDevice(device);

			const screenshot = await robot.getScreenshot();
			fs.writeFileSync(saveTo, screenshot);
			return `Screenshot saved to: ${saveTo}`;
		}
	);

	server.registerTool(
		"mobile_take_screenshot",
		{
			title: "Take Screenshot",
			description: "Take a screenshot of the mobile device. Use this to understand what's on screen, if you need to press an element that is available through view hierarchy then you must list elements on screen instead. Do not cache this result.",
			inputSchema: {
				device: z.string().describe("The device identifier to use. Use mobile_list_available_devices to find which devices are available to you.")
			},
			annotations: {
				readOnlyHint: true,
			},
		},
		async ({ device }) => {
			try {
				const robot = getRobotFromDevice(device);
				const screenSize = await robot.getScreenSize();

				let screenshot = await robot.getScreenshot();
				let mimeType = "image/png";

				// validate we received a png, will throw exception otherwise
				const image = new PNG(screenshot);
				const pngSize = image.getDimensions();
				if (pngSize.width <= 0 || pngSize.height <= 0) {
					throw new ActionableError("Screenshot is invalid. Please try again.");
				}

				if (isScalingAvailable()) {
					trace("Image scaling is available, resizing screenshot");
					const image = Image.fromBuffer(screenshot);
					const beforeSize = screenshot.length;
					screenshot = image.resize(Math.floor(pngSize.width / screenSize.scale))
						.jpeg({ quality: 75 })
						.toBuffer();

					const afterSize = screenshot.length;
					trace(`Screenshot resized from ${beforeSize} bytes to ${afterSize} bytes`);

					mimeType = "image/jpeg";
				}

				const screenshot64 = screenshot.toString("base64");
				trace(`Screenshot taken: ${screenshot.length} bytes`);
				posthog("tool_invoked", {
					"ToolName": "mobile_take_screenshot",
					"ScreenshotFilesize": screenshot64.length,
					"ScreenshotMimeType": mimeType,
					"ScreenshotWidth": pngSize.width,
					"ScreenshotHeight": pngSize.height,
				}).then();

				return {
					content: [{ type: "image", data: screenshot64, mimeType }]
				};
			} catch (err: any) {
				error(`Error taking screenshot: ${err.message} ${err.stack}`);
				return {
					content: [{ type: "text", text: `Error: ${err.message}` }],
					isError: true,
				};
			}
		}
	);

	tool(
		"mobile_set_orientation",
		"Set Orientation",
		"Change the screen orientation of the device",
		{
			device: z.string().describe("The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."),
			orientation: z.enum(["portrait", "landscape"]).describe("The desired orientation"),
		},
		{ destructiveHint: true },
		async ({ device, orientation }) => {
			const robot = getRobotFromDevice(device);
			await robot.setOrientation(orientation);
			return `Changed device orientation to ${orientation}`;
		}
	);

	tool(
		"mobile_get_orientation",
		"Get Orientation",
		"Get the current screen orientation of the device",
		{
			device: z.string().describe("The device identifier to use. Use mobile_list_available_devices to find which devices are available to you.")
		},
		{ readOnlyHint: true },
		async ({ device }) => {
			const robot = getRobotFromDevice(device);
			const orientation = await robot.getOrientation();
			return `Current device orientation is ${orientation}`;
		}
	);

	tool(
		"mobile_get_logs",
		"Get App Logs",
		"Get application logs from the device. Useful for debugging app crashes, errors, and console output. Currently supported on Vega/Fire TV devices.",
		{
			device: z.string().describe("The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."),
			packageName: z.string().optional().describe("Filter logs by app package name (e.g., 'com.amzn.music.hornettv')"),
			lines: z.number().optional().describe("Number of log lines to return (default: 50)"),
			level: z.enum(["all", "error", "warn", "info"]).optional().describe("Filter by log level. 'error' shows only errors, 'warn' shows errors and warnings, 'info' shows all levels."),
			filter: z.string().optional().describe("Regex pattern to filter log messages"),
		},
		{ readOnlyHint: true },
		async ({ device, packageName, lines, level, filter }) => {
			const robot = getRobotFromDevice(device);

			if (!robot.getLogs) {
				throw new ActionableError("Log retrieval is not supported on this device type. Currently only Vega/Fire TV devices support this feature.");
			}

			const logs = await robot.getLogs({ packageName, lines, level, filter });

			if (logs.length === 0) {
				return "No logs found matching the specified criteria.";
			}

			// Format logs for display
			const formattedLogs = logs.map(entry => {
				const levelIcon = entry.level === "error" ? "❌" : entry.level === "warn" ? "⚠️" : "ℹ️";
				const tag = entry.tag ? `[${entry.tag}]` : "";
				return `${levelIcon} ${entry.timestamp} ${tag} ${entry.message}`;
			}).join("\n");

			return `Found ${logs.length} log entries:\n\n${formattedLogs}`;
		}
	);

	tool(
		"mobile_reload_app",
		"Reload App",
		"Trigger a hot reload of the JavaScript bundle. Much faster than a full rebuild - use this after making JS/TS code changes. Requires Metro bundler to be running.",
		{
			device: z.string().describe("The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."),
			metroPort: z.number().optional().describe("Metro bundler port (default: 8081)"),
		},
		{ destructiveHint: true },
		async ({ device, metroPort }) => {
			const robot = getRobotFromDevice(device);

			if (!robot.reloadApp) {
				throw new ActionableError("Hot reload is not supported on this device type. Currently only Vega/Fire TV devices with Metro bundler support this feature.");
			}

			await robot.reloadApp({ metroPort });
			return "App reloaded successfully. The JavaScript bundle has been refreshed.";
		}
	);

	tool(
		"mobile_get_network_requests",
		"Get Network Requests",
		"Get HTTP/GraphQL network requests made by the app. Useful for debugging API calls, seeing request/response bodies, and troubleshooting errors. Requires the app to have NetworkLogger instrumentation (included in Vega TV app devtools).",
		{
			device: z.string().describe("The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."),
			packageName: z.string().optional().describe("Filter by app package name (e.g., 'com.amzn.music.hornettv')"),
			count: z.number().optional().describe("Number of requests to return (default: 20)"),
			filterUrl: z.string().optional().describe("Regex pattern to filter by URL (e.g., 'graphql' or 'api.example.com')"),
		},
		{ readOnlyHint: true },
		async ({ device, packageName, count, filterUrl }) => {
			const robot = getRobotFromDevice(device);

			if (!robot.getNetworkRequests) {
				throw new ActionableError("Network request inspection is not supported on this device type. Currently only Vega/Fire TV devices with app-side NetworkLogger support this feature.");
			}

			const requests = await robot.getNetworkRequests({ packageName, count, filterUrl });

			if (requests.length === 0) {
				return "No network requests found. Make sure the app has NetworkLogger instrumentation and has made some requests.";
			}

			// Format requests for display
			const formattedRequests = requests.map(req => {
				const statusIcon = req.type === "error" ? "❌" :
					req.type === "response" ? (req.status && req.status >= 400 ? "⚠️" : "✅") : "➡️";

				let output = `${statusIcon} ${req.method} ${req.url}`;

				if (req.status !== undefined) {
					output += ` [${req.status}]`;
				}
				if (req.duration !== undefined) {
					output += ` (${req.duration}ms)`;
				}
				if (req.error) {
					output += `\n   Error: ${req.error}`;
				}
				if (req.responseBody) {
					// Truncate long bodies
					const body = req.responseBody.length > 500
						? req.responseBody.substring(0, 500) + "..."
						: req.responseBody;
					output += `\n   Response: ${body}`;
				}

				return output;
			}).join("\n\n");

			return `Found ${requests.length} network requests:\n\n${formattedRequests}`;
		}
	);

	return server;
};
