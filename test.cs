using System;
using System.Net.Http;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

class Program {
    static async Task Main() {
        var client = new HttpClient();
        var html = await client.GetStringAsync("https://raw.githubusercontent.com/chromium/chromium/main/content/browser/bad_message.h");
        var match = Regex.Match(html, @"(?s)enum BadMessageReason \{(.*?)\}");
        if (match.Success) {
            var lines = match.Groups[1].Value.Split('\n');
            int i = 0;
            foreach (var line in lines) {
                if (line.Contains("=")) continue;
                if (string.IsNullOrWhiteSpace(line)) continue;
                if (line.Trim().StartsWith("//")) continue;
                Console.WriteLine($"{i}: {line.Trim()}");
                i++;
            }
        }
    }
}
