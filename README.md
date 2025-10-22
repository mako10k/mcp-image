# AI Image API MCP Server

This MCP server proxies every tool invocation to an AI image generation API deployed on Modal.com. No local inference logic is kept; all requests are forwarded directly to the Modal endpoints.

For most workflows, prefer the `optimize_and_generate_image` tool, which optimizes a prompt and generates an image in one call. Switch to `generate_image` only when you need to override individual parameters manually.

## Features

- **Image generation**: Create PNG images via the Modal text-to-image API.
- **Model catalog**: List available models and inspect their metadata.
- **Prompt optimization**: Call the Modal Job API to refine prompts.
- **One-shot optimize + generate**: Chain optimization and generation in a single request.
- **Modal API pass-through**: Forward MCP tool inputs directly to the Modal API payload.
- **Resource management**: Cache generated images locally and expose them as MCP resources.

## Setup

1. Install dependencies:

	 ```bash
	 npm install
	 ```

2. Build the TypeScript sources:

	 ```bash
	 npm run build
	 ```

3. Install the CLI and avoid bin name conflicts:

	 ```bash
	 # Remove any legacy/unscoped package that publishes the same bin name.
	 npm uninstall -g mcp-image 2>/dev/null || true
	 npm uninstall mcp-image 2>/dev/null || true

	 # Install the scoped CLI locally (recommended) or globally if desired.
	 npm install --save-dev @mako10k/mcp-image
	 # or: npm install -g @mako10k/mcp-image
	 ```

	 `npx` / `npm exec` resolve binaries by name. A previously installed unscoped
	 package called `mcp-image` can shadow this CLI and cause silent exits. Ensure
	 only `@mako10k/mcp-image` remains installed before running commands such as
	 `npx @mako10k/mcp-image`. See the Model Context Protocol guidance on connecting
	 local servers for additional background. [[Connect to local MCP servers |
	 modelcontextprotocol.io](https://modelcontextprotocol.io/docs/develop/connect-local-servers)]

4. Configure your JOB API server URL by exporting environment variables:

	 ```bash
	 export MODAL_JOB_API_URL="https://your-deployment--ai-image-jobapi-serve.modal.run"
	 export JOBAPI_API_KEY="your-api-key-here"
	 ```

5. Register the server with your MCP client (for example, VS Code):

	 ```bash
	 # Copy the example MCP configuration
	 cp .vscode/mcp.json.example .vscode/mcp.json
	 
	 # Edit .vscode/mcp.json with your actual paths and credentials
	 nano .vscode/mcp.json
	 ```

	 Example configuration:
	 ```json
	 {
		 "servers": {
			 "ai-image-api-mcp-server": {
				 "type": "stdio",
				 "command": "node",
				 "args": ["/path/to/mcp-image/dist/index.js"],
				 "env": {
					 "MODAL_JOB_API_URL": "https://your-deployment--ai-image-jobapi-serve.modal.run",
					 "JOBAPI_API_KEY": "your-api-key-here"
				 }
			 }
		 }
	 }
	 ```

### Connecting to the JOB API server

The server connects to a JOB API server for **all operations** including image generation, model information, and prompt optimization. All requests are proxied through the JOB API server.

**Required environment variables:**

- `MODAL_JOB_API_URL` (or `JOB_API_SERVER_URL`) - JOB API server endpoint
- `JOBAPI_API_KEY` - API key for authentication

Example:
```bash
export MODAL_JOB_API_URL=https://your-deployment--ai-image-jobapi-serve.modal.run
export JOBAPI_API_KEY=your-api-key-here
```

### Running the CLI quickly with npx / npm exec

Once the conflicting package cleanup is complete you can launch the server via

```bash
npx --yes @mako10k/mcp-image
# or
npm exec --yes @mako10k/mcp-image
```

If you must keep the unscoped `mcp-image` package for another project, prefer an
explicit path:

```bash
./node_modules/.bin/mcp-image
```

This ensures the scoped CLI is selected even when other versions are present.

The JOB API server provides the following endpoints:
- `POST /text-to-image` - Image generation (proxies Modal text-to-image)
- `GET /model-configs` - Model list (proxies Modal get-model-configs)
- `GET /model-configs/{model_name}` - Model detail
- `POST /optimize_params_v2` - Prompt optimization
- `GET /images/{image_token}` - Image retrieval by token
- `POST /optimize_and_generate_image` - Combined optimize + generate

## Available tools

### optimize_and_generate_image (recommended)
Primary tool that optimizes a prompt and generates an image in a single call. It automatically feeds the `optimize_prompt` result into the generator and returns both the image and the optimization details as JSON.

**Key parameters:**

- `query` (required): Natural-language description to optimize.
- `target_model`: Model name to prefer during optimization.
- `generation_overrides`: Object containing overrides applied during generation (same keys as `generate_image`).

Because the recommended settings are applied automatically, start with this tool. Switch to `generate_image` only when you need fine-grained control.

### generate_image
Generate an image directly from a natural-language prompt. Use this when you need precise parameter control or want to bypass the optimizer. Every field you pass from MCP is forwarded to the Modal text-to-image API as-is.

**Key parameters:**

- `prompt` (required): Prompt used for generation.
- `model`: Model name to use. Defaults to `dreamshaper8`.
- `negative_prompt`: Elements to exclude.
- `guidance_scale`: Classifier-Free Guidance scale.
- `steps`: Number of diffusion steps (integer).
- `width` / `height`: Output size (multiples of 64, between 256 and 2048).
- `seed`: Random seed (integer).
- `scheduler`: Scheduler name.

Any additional fields you supply are forwarded without extra validation. `width` and `height` must be multiples of 64 and within 256–2048.

### get_available_models
Return the list of supported image generation models.

### get_model_detail
Retrieve detailed information for a specific model.

**Parameters:**

- `model_name` (required): Name of the model to inspect.

### optimize_prompt
Optimize a prompt for image generation and surface recommended parameters. Normally you do not need to call this directly because `optimize_and_generate_image` uses it internally, but it is available when you only need the optimization output.

**Parameters:**

- `query` (required): Prompt or scene description to optimize.
- `target_model`: Optional model to target.

### search_images
Search the local cache of generated images. Modal does not provide a search endpoint, so this server filters its own metadata store.

**Parameters:**

- `query`: Keyword to match within prompts (substring match).
- `model`: Restrict results to images generated by a specific model.
- `limit`: Maximum number of results (1–20, default 5).
- `before`: Only include images generated before this ISO 8601 timestamp.
- `after`: Only include images generated after this ISO 8601 timestamp.

## Managing generated resources

- Generated PNG files are stored at `~/.cache/ai-image-api-mcp/images`.
- Metadata accumulates at `~/.cache/ai-image-api-mcp/metadata.json` and is exposed via the MCP resource API.
- Resource URI format: `resource://ai-image-api/image/<uuid>`.
- The `generate_image` response includes the `resourceUri` for the saved image.
- The `search_images` tool queries the local metadata cache.

### Inspecting cached images

```bash
npm run single-test
```

After the script completes, the latest image appears in the `resources/list` response and can be previewed directly from an MCP client such as VS Code.

## API endpoints

All API calls are proxied through the JOB API server:

- Image generation: `POST /text-to-image`
- Model list: `GET /model-configs`
- Model detail: `GET /model-configs/{model_name}`
- Prompt optimization: `POST /optimize_params_v2`
- Image retrieval: `GET /images/{image_token}`
- Combined workflow: `POST /optimize_and_generate_image`

Configure the JOB API server URL via `MODAL_JOB_API_URL` environment variable.

## Examples

```javascript
// Sample MCP client usage

// 1. Optimize and generate (recommended)
await mcp.callTool('optimize_and_generate_image', {
	query: 'Futuristic cityscape at sunset viewed from above',
	generation_overrides: {
		width: 768,
		height: 512
	}
});

// 2. Direct generation when you need manual tweaks
await mcp.callTool('generate_image', {
	prompt: 'Futuristic cityscape at sunset viewed from above',
	model: 'dreamshaper8',
	negative_prompt: 'blurry, low quality',
	width: 768,
	height: 512,
	steps: 20,
	guidance_scale: 7.5
});

// 3. List available models
await mcp.callTool('get_available_models', {});

// 4. Obtain only the optimization output
await mcp.callTool('optimize_prompt', {
	query: 'A cat relaxing in a garden'
});
```

## Development

Run the server in development mode:

```bash
npm run dev
```

## License

MIT License
