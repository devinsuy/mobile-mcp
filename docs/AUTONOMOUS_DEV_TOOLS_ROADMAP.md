# Autonomous Development Tools Roadmap

Tools to improve LLM autonomous development on Vega OS / mobile platforms.

---

## 1. App Console/Logs (`mobile_get_logs`)

### Problem
When the app crashes or has JS errors, I see a black screen with no information. I have to guess what went wrong or add console.logs and rebuild (30+ second cycles).

### Solution
Add a tool that retrieves logs from the running app:
- React Native console output (console.log, console.warn, console.error)
- JS exception stack traces
- Native crash logs from Vega OS

### Implementation Approach
For Vega OS, investigate:
- `vega device logs` CLI command
- `loggingctl` (we already use this for element detection)
- ADB-style logcat equivalent for Vega
- Metro bundler's log forwarding

### Tool Signature
```typescript
mobile_get_logs(device: string, options?: {
  filter?: string,      // Regex to filter log lines
  lines?: number,       // Last N lines (default 100)
  level?: 'all' | 'error' | 'warn' | 'info'
})
```

### Success Criteria
- Can see `console.log("hello")` output from the app
- Can see JS exception stack traces when app crashes
- Can filter logs to find specific errors

---

## 2. Network Request Inspector (`mobile_get_network_requests`)

### Problem
When GraphQL calls fail, I can't see what the app actually sent or received. I have to:
1. Guess the error from symptoms
2. Use curl separately to test the API
3. Compare my curl to what the app might be doing

### Solution
Intercept/log HTTP requests from the app:
- Request URL, method, headers, body
- Response status, headers, body
- Timing information

### Implementation Approach
Options to investigate:
1. **React Native Network Inspector** - If Metro has a debug mode
2. **Proxy-based** - Route traffic through a logging proxy
3. **In-app instrumentation** - Add fetch/XMLHttpRequest interceptor to the app
4. **Vega OS network logging** - Platform-level HTTP logging

### Tool Signature
```typescript
mobile_get_network_requests(device: string, options?: {
  last_n?: number,           // Last N requests (default 20)
  filter_url?: string,       // Filter by URL pattern
  filter_method?: string,    // GET, POST, etc.
  include_body?: boolean     // Include request/response bodies
})
```

### Success Criteria
- Can see GraphQL requests sent by the app
- Can see response bodies (including error messages)
- Can see what headers were actually sent

---

## 3. Hot Reload Trigger (`mobile_reload_app`)

### Problem
Every code change requires:
1. `npm run build:debug` (~25 seconds)
2. `mobile_install_app` (~5 seconds)
3. `mobile_launch_app` (~3 seconds)

This is 30+ seconds per iteration, even for a one-line change.

### Solution
Trigger a JavaScript bundle reload without full rebuild:
- Metro bundler serves updated JS
- App reloads just the JS bundle
- Native code unchanged = instant reload

### Implementation Approach
1. **Metro reload endpoint** - Metro has a `/reload` HTTP endpoint
2. **Vega CLI** - Check if `vega device` has reload support
3. **In-app dev menu** - Trigger reload via accessibility/automation
4. **Keyboard shortcut simulation** - Send "R" key to trigger RN reload

### Tool Signature
```typescript
mobile_reload_app(device: string, options?: {
  clear_cache?: boolean  // Clear Metro cache before reload
})
```

### Success Criteria
- Code change → reload in <3 seconds
- No full rebuild required for JS-only changes
- Clear feedback when reload succeeds/fails

---

## 4. Improved Metro Bundler Integration

### Problem
Metro bundler runs in background but:
- Output is noisy and hard to parse
- Build errors get buried in logs
- No structured way to know build status

### Solution
Better Metro integration:
- Parse build success/failure
- Extract error messages cleanly
- Provide build status queries

### Implementation Approach
1. **Parse Metro output** - Regex for build status patterns
2. **Metro status endpoint** - HTTP API for build status
3. **Structured log format** - Configure Metro for machine-readable output

### Tool Signature
```typescript
mobile_get_build_status(device: string) -> {
  status: 'building' | 'ready' | 'error',
  error_message?: string,
  last_build_time?: number
}
```

### Success Criteria
- Know when build is complete
- Get clean error messages on failure
- No manual log parsing required

---

## 5. GraphQL Schema Introspection

### Problem
When writing GraphQL queries, I have to:
1. Guess field names
2. Try the query
3. Get error "field X doesn't exist"
4. Read main app code to find correct name
5. Repeat

### Solution
Query the GraphQL schema directly to know:
- Available types and fields
- Field types and nullability
- Query/mutation signatures

### Implementation Approach
1. **Introspection query** - Standard GraphQL `__schema` query
2. **Cache locally** - Save schema for reference
3. **Tool or documentation** - Make schema accessible during development

### Tool Signature
```typescript
graphql_introspect(endpoint: string, headers?: object) -> {
  types: [...],
  queries: [...],
  mutations: [...]
}
```

Or simpler - just a way to run introspection query and cache results.

### Success Criteria
- Can look up field names without guessing
- Can see type structure before writing queries
- Reduces GraphQL trial-and-error cycles

---

## Priority Order

| # | Tool | Impact | Complexity |
|---|------|--------|------------|
| 1 | `mobile_get_logs` | High | Medium |
| 2 | `mobile_reload_app` | High | Low-Medium |
| 3 | `mobile_get_network_requests` | High | High |
| 4 | Metro integration | Medium | Low |
| 5 | GraphQL introspection | Medium | Low |

**Recommended order:** Start with #1 (logs) since it has high impact and we already have `loggingctl` working for Vega. Then #2 (reload) for faster iteration.
