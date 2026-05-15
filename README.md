# Convertly MCP

Convertly MCP is a local Model Context Protocol server for AI agents that need to work with approved folders and Convertly media APIs.

Use it from Claude, ChatGPT, Cursor, or another MCP-compatible client to organize files, convert media, remove backgrounds, vectorize, watermark, trim video, generate thumbnails, create GIFs, compress images, extract audio, inspect metadata, convert currencies, manage cloud storage, and more.

## Install

Configure your MCP client to run the package with `npx`:

```json
{
  "mcpServers": {
    "convertly": {
      "command": "npx",
      "args": ["-y", "@convertly/mcp"],
      "env": {
        "CONVERTLY_API_KEY": "ctly_live_...",
        "CONVERTLY_MCP_ROOTS": "/Users/you/Downloads:/Users/you/Pictures"
      }
    }
  }
}
```

On Windows, separate approved roots with `;`:

```json
{
  "mcpServers": {
    "convertly": {
      "command": "npx",
      "args": ["-y", "@convertly/mcp"],
      "env": {
        "CONVERTLY_API_KEY": "ctly_live_...",
        "CONVERTLY_MCP_ROOTS": "C:/Users/you/Downloads;C:/Users/you/Pictures"
      }
    }
  }
}
```

`CONVERTLY_MCP_ROOTS` controls which folders the server can read or write. If omitted, only the current working directory is approved.

## Tools

### Docs
- `list_convertly_docs` — list Convertly documentation pages
- `search_convertly_docs` — search Convertly docs by topic
- `get_convertly_doc` — fetch readable text for a Convertly docs page

### Filesystem
- `list_roots` — show approved folders
- `scan_folder` — list files with size, modified date, and media category
- `plan_organize_folder` — dry-run moves into Images, Videos, Audio, Archives, Documents, and Other
- `move_files` — move files inside approved roots after `confirm: true`
- `create_archive` — create ZIP archives inside approved roots
- `delete_files` — delete files only when `confirm` is `true`

### Conversion & Compression
- `convert_media` — convert images, video, audio, documents, and archives
- `compress_media` — compress image, video, or audio files

### AI Media Tools
- `remove_background` — AI background removal for images
- `transform_image` — resize, crop, rotate, flip, format-shift images
- `generate_thumbnail` — create thumbnails from images or videos
- `watermark_media` — add text or logo watermarks to images and videos
- `create_storyboard` — generate storyboard grid images from videos
- `trim_media` — trim video and audio to a start time and duration
- `video_to_gif` — convert videos to animated GIFs
- `pdf_preview` — convert PDF pages to image previews
- `poster_frame` — extract poster frames from videos
- `extract_audio` — extract audio tracks from videos
- `strip_metadata` — remove metadata from media files
- `images_to_pdf` — combine images into a single PDF
- `inspect_media` — read metadata and properties for media files
- `adjust_media` — apply brightness, contrast, saturation, hue, grayscale, and other adjustments

### Transfer & Utilities
- `transfer_url` — download public remote URLs to approved local folders
- `convert_currency` — convert currencies using Convertly exchange rates

### Async Jobs
- `list_jobs` — list recent async conversion and media-tool jobs
- `get_job` — get status and results for a specific job

### Cloud Storage
- `list_cloud_files` — list files in Convertly cloud storage
- `delete_cloud_file` — delete a file from cloud storage
- `list_folders` — list folders in cloud storage

## Safety

The model does not receive raw filesystem access. All filesystem paths are resolved and checked against approved roots. Move and delete operations require `confirm: true`, and planning tools return dry-run output by default.
