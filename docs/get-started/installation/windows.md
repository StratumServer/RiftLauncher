---
description: If you're using Windows follow this guide!
icon: windows
---

# Windows

The first thing you've to do is download the `.exe` from the Github Releases Page to install RiftLauncher. Just follow this steps:

{% stepper %}
{% step %}

### Go to the [GitHub Releases Page](https://github.com/StratumServer/RiftLauncher/releases)

On that page you'll see all the available versions to download.
{% endstep %}

{% step %}

### Download the Windows version

On the releases page, the first version is always the last one. There you'll see a table with the different files to download. The Windows one is `riftlauncher-X.X.X-setup.exe`, where `X.X.X` is the version number.
{% endstep %}

{% step %}

### Install the downloaded file

Double click the downloaded file. The installer lets you pick where to install RiftLauncher, then puts a desktop and a Start menu shortcut called **RiftLauncher** in place and opens the launcher when it's done.
{% endstep %}

{% step %}

### Install .NET 7, 8 and 10

If you already played Vintage Story on this machine before, these are likely installed already and you can skip this step. Otherwise grab all three from the [.NET downloads page](https://dotnet.microsoft.com/download/dotnet): Vintage Story versions need different .NET major versions depending on when they were built, so having 7, 8 and 10 covers you whichever version you end up playing.

Once the downloads are complete just install them.
{% endstep %}
{% endstepper %}

And that's it... easy right? Now with this launcher it'll be even easier to install Vintage Story.

---

## SmartScreen and antivirus warnings

The first time you run a new RiftLauncher installer, Windows may stop it with a blue **"Windows protected your PC"** box. That is SmartScreen. Click **More info**, then **Run anyway**, and the installer carries on as normal.

It is not telling you the file is malicious, only that it has never seen this file before. Our installers aren't code-signed, so SmartScreen has no publisher identity to recognise and no download history to lean on, and every release resets that history because every release is a brand-new file. For the same reason an antivirus scanner may score a fresh installer as suspicious on the day it comes out. Getting the installer signed is tracked in [issue #351](https://github.com/StratumServer/RiftLauncher/issues/351).

You don't have to take our word for any of that. Every release ships two things you can check before running anything:

{% stepper %}
{% step %}

### Compare the SHA-256

The release notes list a SHA-256 for every file. Open PowerShell or Command Prompt in your Downloads folder and run:

```powershell
certutil -hashfile riftlauncher-X.X.X-setup.exe SHA256
```

The hash it prints should match the one in the notes, ignoring case and spaces. If it doesn't, the file you have is not the file we published: delete it and download it again from the [GitHub Releases Page](https://github.com/StratumServer/RiftLauncher/releases).
{% endstep %}

{% step %}

### Read the VirusTotal report

Next to each hash in the notes there is a VirusTotal link with a detection count, for example "2 of 72 engines". It goes to the report for that exact file, so you can see which engines flagged it and what they called it.

A couple of hits on an unsigned installer is normal and usually reads as something generic, along the lines of a machine-learning or heuristic detection rather than a named piece of malware. A report full of detections is not normal; if you see one, tell us on the [Stratum Discord server](https://discord.gg/vQm6z2urZs) before running the file.

For reference, the `1.7.0-beta.10` installer came back clean when it was scanned at release time, with no engine flagging it.
{% endstep %}
{% endstepper %}

Every build on the releases page is produced by GitHub Actions from the public source, and the workflow that does it is in the repository.
