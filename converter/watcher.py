"""
Watch Folder Service for automatic WSI conversion

Monitors the uploads/incoming folder for new WSI files and
automatically triggers conversion to DICOM.
"""

import os
import time
import asyncio
from pathlib import Path
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler, FileCreatedEvent
import httpx

# Configuration
WATCH_FOLDER = os.getenv("WATCH_FOLDER", "/uploads")
INCOMING_DIR = Path(WATCH_FOLDER) / "incoming"
CONVERTER_URL = os.getenv("CONVERTER_INTERNAL_URL", "http://localhost:8000")

# Supported extensions
SUPPORTED_EXTENSIONS = {
    ".ndpi", ".svs", ".tif", ".tiff", ".dcx", ".isyntax",
    ".mrxs", ".scn", ".bif", ".vsi"
}


class WSIFileHandler(FileSystemEventHandler):
    """Handle new WSI files in the watch folder"""

    def __init__(self):
        self.pending_files = {}  # Track files being written
        self.min_stable_time = 5  # Seconds file must be stable before processing

    def on_created(self, event: FileCreatedEvent):
        """Called when a new file is created"""
        if event.is_directory:
            return

        file_path = Path(event.src_path)
        
        # Check if it's a supported format
        if file_path.suffix.lower() not in SUPPORTED_EXTENSIONS:
            print(f"⏭️  Ignoring unsupported file: {file_path.name}")
            return

        print(f"📁 New file detected: {file_path.name}")
        self.pending_files[str(file_path)] = time.time()

    def on_modified(self, event):
        """Called when a file is modified (still being written)"""
        if event.is_directory:
            return
        
        file_path = str(event.src_path)
        if file_path in self.pending_files:
            # Update timestamp - file is still being written
            self.pending_files[file_path] = time.time()

    def check_stable_files(self):
        """Check for files that have finished uploading"""
        now = time.time()
        stable_files = []

        for file_path, last_modified in list(self.pending_files.items()):
            if now - last_modified >= self.min_stable_time:
                # File hasn't been modified for min_stable_time seconds
                if Path(file_path).exists():
                    stable_files.append(file_path)
                del self.pending_files[file_path]

        return stable_files


async def process_file(file_path: str):
    """Submit a file for conversion via the API"""
    file_path = Path(file_path)
    
    print(f"🔄 Processing: {file_path.name}")
    
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            with open(file_path, "rb") as f:
                files = {"file": (file_path.name, f)}
                response = await client.post(
                    f"{CONVERTER_URL}/upload",
                    files=files
                )
            
            if response.status_code == 200:
                result = response.json()
                print(f"✅ Queued for conversion: {result.get('job_id')}")
            else:
                print(f"❌ Failed to queue: {response.status_code} - {response.text}")
                
    except Exception as e:
        print(f"❌ Error processing {file_path.name}: {e}")


async def watch_folder():
    """Main watch loop"""
    print(f"👁️  Watching folder: {INCOMING_DIR}")
    
    # Ensure directories exist
    INCOMING_DIR.mkdir(parents=True, exist_ok=True)
    
    # Set up file watcher
    event_handler = WSIFileHandler()
    observer = Observer()
    observer.schedule(event_handler, str(INCOMING_DIR), recursive=False)
    observer.start()

    try:
        while True:
            # Check for stable files every second
            stable_files = event_handler.check_stable_files()
            
            for file_path in stable_files:
                await process_file(file_path)
            
            await asyncio.sleep(1)
            
    except KeyboardInterrupt:
        print("\n👋 Stopping watcher...")
        observer.stop()
    
    observer.join()


def main():
    """Entry point"""
    print("=" * 50)
    print("DICOM WSI Watch Folder Service")
    print("=" * 50)
    print(f"Watch folder: {INCOMING_DIR}")
    print(f"Converter URL: {CONVERTER_URL}")
    print(f"Supported formats: {', '.join(SUPPORTED_EXTENSIONS)}")
    print("=" * 50)
    
    asyncio.run(watch_folder())


if __name__ == "__main__":
    main()

