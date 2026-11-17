#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Video-Clipper App - Turn any video into a 30-second short.

Usage
-----
    python clipper.py input.mp4                # first 30 s
    python clipper.py input.mp4 45             # 45 s -> 75 s
    python clipper.py input.mp4 10 20          # 10 s -> 30 s (start 10, length 20)
    python clipper.py input.mp4 -o short.mp4   # explicit output path
    python clipper.py                          # opens the Tkinter GUI

Works with any format FFmpeg supports (MP4, MOV, AVI, MKV, WEBM, ...).

Dependencies: Python 3.8+, moviepy (1.x or 2.x), FFmpeg (moviepy bundles one
through imageio-ffmpeg).

License: MIT
"""

import argparse
import pathlib
import sys
from typing import Optional

# moviepy 1.x exposes VideoFileClip in moviepy.editor; 2.x removed that module.
try:
    from moviepy import VideoFileClip  # moviepy >= 2.0
except ImportError:
    try:
        from moviepy.editor import VideoFileClip  # moviepy 1.x
    except ImportError:
        print("moviepy is not installed. Run: pip install -r requirements.txt")
        sys.exit(1)

DEFAULT_DURATION = 30.0  # seconds


def get_output_path(input_path: pathlib.Path, start: float, end: float) -> pathlib.Path:
    """video.mp4 -> video_clip_0-30.mp4 (adds _1, _2, ... if it already exists)."""
    base = f"{input_path.stem}_clip_{int(start)}-{int(end)}"
    out_path = input_path.parent / f"{base}{input_path.suffix}"
    counter = 1
    while out_path.exists():
        out_path = input_path.parent / f"{base}_{counter}{input_path.suffix}"
        counter += 1
    return out_path


def _cut(clip, start: float, end: float):
    """subclip() in moviepy 1.x, subclipped() in 2.x."""
    if hasattr(clip, "subclipped"):
        return clip.subclipped(start, end)
    return clip.subclip(start, end)


def clip_video(
    input_file: pathlib.Path,
    start: Optional[float] = None,
    duration: float = DEFAULT_DURATION,
    output: Optional[pathlib.Path] = None,
) -> pathlib.Path:
    """Cut `duration` seconds from `input_file` starting at `start`; return the output path."""
    input_file = pathlib.Path(input_file)
    if not input_file.is_file():
        raise FileNotFoundError(f"Input file not found: {input_file}")
    if duration <= 0:
        raise ValueError("Duration must be greater than 0.")

    with VideoFileClip(str(input_file)) as clip:
        video_len = clip.duration
        start = max(0.0, start or 0.0)
        if start >= video_len:
            raise ValueError(
                f"Start time {start:.2f}s is past the end of the video ({video_len:.2f}s)."
            )
        end = min(start + duration, video_len)

        print(f"Source length: {video_len:.2f}s")
        print(f"Cutting from {start:.2f}s to {end:.2f}s ({end - start:.2f}s)")

        out_path = pathlib.Path(output) if output else get_output_path(input_file, start, end)
        out_path.parent.mkdir(parents=True, exist_ok=True)

        sub = _cut(clip, start, end)
        try:
            sub.write_videofile(
                str(out_path),
                codec="libx264",
                audio_codec="aac",
                threads=4,
                logger=None,
            )
        finally:
            sub.close()

    print(f"Saved short to: {out_path}")
    return out_path


def parse_cli_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Clip any video to a 30-second short (or custom length)."
    )
    parser.add_argument("input", nargs="?", type=pathlib.Path,
                        help="Path to the source video file.")
    parser.add_argument("start", nargs="?", type=float, default=None,
                        help="Start time in seconds (default: 0).")
    parser.add_argument("duration", nargs="?", type=float, default=DEFAULT_DURATION,
                        help=f"Clip length in seconds (default: {DEFAULT_DURATION:g}).")
    parser.add_argument("-o", "--output", type=pathlib.Path, default=None,
                        help="Explicit output path (default: auto-generated next to input).")
    parser.add_argument("--no-gui", action="store_true",
                        help="Never open the GUI; print usage if no input is given.")
    return parser.parse_args()


def launch_gui() -> None:
    """Minimal Tkinter front end."""
    import threading
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk

    root = tk.Tk()
    root.title("30-Second Video Clipper")
    root.resizable(False, False)

    pad = {"padx": 8, "pady": 4}
    var_input = tk.StringVar()
    var_start = tk.StringVar(value="0")
    var_dur = tk.StringVar(value=f"{DEFAULT_DURATION:g}")
    var_status = tk.StringVar(value="Pick a video to begin.")

    def browse() -> None:
        name = filedialog.askopenfilename(
            title="Select video to clip",
            filetypes=[("Video files", "*.mp4 *.mov *.avi *.mkv *.webm *.flv *.wmv"),
                       ("All files", "*.*")],
        )
        if name:
            var_input.set(name)

    def finish(ok: bool, message: str) -> None:
        progress.stop()
        btn_run.config(state="normal")
        var_status.set(message)
        (messagebox.showinfo if ok else messagebox.showerror)(
            "Success" if ok else "Error", message
        )

    def run() -> None:
        try:
            start = float(var_start.get() or 0)
            dur = float(var_dur.get() or DEFAULT_DURATION)
        except ValueError:
            messagebox.showerror("Invalid input", "Start and duration must be numbers.")
            return
        path = pathlib.Path(var_input.get().strip())
        if not path.is_file():
            messagebox.showerror("File not found", f"No such file: {path}")
            return

        btn_run.config(state="disabled")
        var_status.set("Working...")
        progress.start(10)

        def work() -> None:
            try:
                out = clip_video(path, start=start, duration=dur)
                root.after(0, finish, True, f"Saved: {out}")
            except Exception as exc:  # show any failure in the UI
                root.after(0, finish, False, str(exc))

        threading.Thread(target=work, daemon=True).start()

    ttk.Label(root, text="Video file:").grid(row=0, column=0, sticky="e", **pad)
    ttk.Entry(root, textvariable=var_input, width=48).grid(row=0, column=1, **pad)
    ttk.Button(root, text="Browse...", command=browse).grid(row=0, column=2, **pad)

    ttk.Label(root, text="Start (s):").grid(row=1, column=0, sticky="e", **pad)
    ttk.Entry(root, textvariable=var_start, width=10).grid(row=1, column=1, sticky="w", **pad)

    ttk.Label(root, text="Length (s):").grid(row=2, column=0, sticky="e", **pad)
    ttk.Entry(root, textvariable=var_dur, width=10).grid(row=2, column=1, sticky="w", **pad)

    btn_run = ttk.Button(root, text="Create short", command=run)
    btn_run.grid(row=3, column=1, sticky="w", **pad)

    progress = ttk.Progressbar(root, mode="indeterminate", length=300)
    progress.grid(row=4, column=0, columnspan=3, **pad)
    ttk.Label(root, textvariable=var_status, wraplength=420).grid(
        row=5, column=0, columnspan=3, **pad)

    root.mainloop()


def main() -> int:
    args = parse_cli_args()

    if args.input is None:
        if args.no_gui:
            print("No input file given. Usage: python clipper.py input.mp4 [start] [duration]")
            return 2
        launch_gui()
        return 0

    try:
        clip_video(args.input, start=args.start, duration=args.duration, output=args.output)
    except (FileNotFoundError, ValueError) as exc:
        print(f"Error: {exc}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
