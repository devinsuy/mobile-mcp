export interface Dimensions {
	width: number;
	height: number;
}

export interface ScreenSize extends Dimensions {
	scale: number;
}

export interface InstalledApp {
	packageName: string;
	appName: string;
}

export type SwipeDirection = "up" | "down" | "left" | "right";

export type Button = "HOME" | "BACK" | "VOLUME_UP" | "VOLUME_DOWN" | "ENTER" | "DPAD_CENTER" | "DPAD_UP" | "DPAD_DOWN" | "DPAD_LEFT" | "DPAD_RIGHT";

export interface ScreenElementRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface ScreenElement {
	type: string;
	label?: string;
	text?: string;
	name?: string;
	value?: string;
	identifier?: string;
	rect: ScreenElementRect;

	// currently only on android tv
	focused?: boolean;
}

export class ActionableError extends Error {
	constructor(message: string) {
		super(message);
	}
}

export type Orientation = "portrait" | "landscape";

export interface LogEntry {
	timestamp: string;
	level: "info" | "warn" | "error" | "debug";
	tag?: string;
	message: string;
}

export interface GetLogsOptions {
	packageName?: string;  // Filter by app package
	lines?: number;        // Number of lines to return (default 50)
	level?: "all" | "error" | "warn" | "info";  // Filter by level
	filter?: string;       // Regex filter for message content
}

export interface ReloadOptions {
	metroPort?: number;    // Metro bundler port (default 8081)
}

export interface NetworkRequest {
	id: string;
	timestamp: string;
	type: "request" | "response" | "error";
	method: string;
	url: string;
	status?: number;
	duration?: number;
	requestHeaders?: Record<string, string>;
	requestBody?: string;
	responseBody?: string;
	error?: string;
}

export interface GetNetworkRequestsOptions {
	packageName?: string;  // Filter by app package
	count?: number;        // Number of requests to return (default 20)
	filterUrl?: string;    // Regex to filter by URL
}

export interface Robot {
	/**
	 * Get the screen size of the device in pixels.
	 */
	getScreenSize(): Promise<ScreenSize>;

	/**
	 * Swipe in a direction.
	 */
	swipe(direction: SwipeDirection): Promise<void>;

	/**
	 * Swipe from a specific coordinate in a direction.
	 */
	swipeFromCoordinate(x: number, y: number, direction: SwipeDirection, distance?: number): Promise<void>;

	/**
	 * Get a screenshot of the screen. Returns a Buffer that contains
	 * a PNG image of the screen. Will be same dimensions as getScreenSize().
	 */
	getScreenshot(): Promise<Buffer>;

	/**
	 * List all installed apps on the device. Returns an array of package names (or
	 * bundle identifiers in iOS) for all installed apps.
	 */
	listApps(): Promise<InstalledApp[]>;

	/**
	 * Launch an app.
	 */
	launchApp(packageName: string): Promise<void>;

	/**
	 * Terminate an app. If app was already terminated (or non existent) then this
	 * is a no-op.
	 */
	terminateApp(packageName: string): Promise<void>;

	/**
	 * Install an app on the device from a file path.
	 */
	installApp(path: string): Promise<void>;

	/**
	 * Uninstall an app from the device.
	 */
	uninstallApp(bundleId: string): Promise<void>;

	/**
	 * Open a URL in the device's web browser. Can be an https:// url, or a
	 * custom scheme (e.g. "myapp://").
	 */
	openUrl(url: string): Promise<void>;

	/**
	 * Send keys to the device, simulating keyboard input.
	 */
	sendKeys(text: string): Promise<void>;

	/**
	 * Press a button on the device, simulating a physical button press.
	 */
	pressButton(button: Button): Promise<void>;

	/**
	 * Tap on a specific coordinate on the screen.
	 */
	tap(x: number, y: number): Promise<void>;

	/**
	 * Tap on a specific coordinate on the screen.
	 */
	doubleTap(x: number, y: number): Promise<void>;

	/**
	 * Long press on a specific coordinate on the screen.
	 * @param x - The x coordinate to long press
	 * @param y - The y coordinate to long press
	 * @param duration - Duration of the long press in milliseconds
	 */
	longPress(x: number, y: number, duration: number): Promise<void>;

	/**
	 * Get all elements on the screen. Works only on native apps (not webviews). Will
	 * return a filtered list of elements that make sense to interact with.
	 */
	getElementsOnScreen(): Promise<ScreenElement[]>;

	/**
	 * Change the screen orientation of the device.
	 * @param orientation The desired orientation ("portrait" or "landscape")
	 */
	setOrientation(orientation: Orientation): Promise<void>;

	/**
	 * Get the current screen orientation.
	 */
	getOrientation(): Promise<Orientation>;

	/**
	 * Get application logs from the device.
	 * @param options - Options for filtering logs
	 * @returns Array of log entries
	 */
	getLogs?(options?: GetLogsOptions): Promise<LogEntry[]>;

	/**
	 * Reload the JavaScript bundle (hot reload).
	 * Triggers Metro bundler to send updated JS to the app.
	 * @param options - Reload options
	 */
	reloadApp?(options?: ReloadOptions): Promise<void>;

	/**
	 * Get network requests logged by the app.
	 * Requires app-side instrumentation (NetworkLogger).
	 * @param options - Options for filtering requests
	 * @returns Array of network requests
	 */
	getNetworkRequests?(options?: GetNetworkRequestsOptions): Promise<NetworkRequest[]>;
}
