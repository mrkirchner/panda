# Homebrew formula template. scripts/package-macos.sh fills in the @...@ values (jellyfin-ffmpeg's
# from packaging/jellyfin-ffmpeg.txt) and writes the finished formula to target/dist/panda.rb;
# copy that into your tap (e.g. a homebrew-panda repo).
class Panda < Formula
  desc "Self-hosted media server with a TV app, Sonarr and Radarr requests"
  homepage "@HOMEPAGE@"
  url "@URL@"
  version "@VERSION@"
  sha256 "@SHA256@"
  license "Apache-2.0"

  depends_on arch: :arm64
  depends_on :macos

  # Jellyfin's FFmpeg build: HDR tone mapping and VideoToolbox fixes that stock FFmpeg lacks.
  resource "jellyfin-ffmpeg" do
    url "@FFMPEG_URL@"
    sha256 "@FFMPEG_SHA256@"
  end

  def install
    libexec.install "panda"
    resource("jellyfin-ffmpeg").stage { (libexec/"jellyfin-ffmpeg").install "ffmpeg", "ffprobe" }
    # `panda` always finds the bundled FFmpeg; `ffmpeg = ...` in panda.toml still wins.
    (bin/"panda").write_env_script libexec/"panda", PANDA_FFMPEG: libexec/"jellyfin-ffmpeg/ffmpeg"
    pkgshare.install "panda.example.toml"
    # The license, credit and legal notes (Homebrew links them in the keg).
    prefix.install "LICENSE", "NOTICE", "LEGAL.md"
  end

  def caveats
    <<~EOS
      Start Panda now and at every login:
        brew services start panda

      Then open http://localhost:8096. The first time, the admin setup link is in:
        #{var}/log/panda.log

      Your settings, database and artwork live in ~/Library/Application Support/Panda
      (put panda.toml there; example: #{pkgshare}/panda.example.toml).
      Previews and transcodes go to ~/Library/Caches/Panda.
    EOS
  end

  service do
    run opt_bin/"panda"
    keep_alive true
    log_path var/"log/panda.log"
    error_log_path var/"log/panda.log"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/panda --version")

    port = free_port
    ENV["PANDA_DATA_DIR"] = (testpath/"data").to_s
    ENV["PANDA_CACHE_DIR"] = (testpath/"cache").to_s
    ENV["PANDA_BIND"] = "127.0.0.1:#{port}"
    pid = spawn bin/"panda"
    begin
      output = ""
      20.times do
        sleep 1
        output = shell_output("curl -fsS http://127.0.0.1:#{port}/health 2>/dev/null || true")
        break if output == "ok"
      end
      assert_equal "ok", output
      assert_path_exists testpath/"data/setup-token"
    ensure
      Process.kill("TERM", pid)
      Process.wait(pid)
    end
  end
end
