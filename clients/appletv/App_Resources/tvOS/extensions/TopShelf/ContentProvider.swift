// Panda's Top Shelf: Continue Watching and Recently Added on the Apple TV home screen while
// Panda's icon is focused (like Plex). tvOS runs this extension on its own, so it can't use the
// app's sign-in: the app leaves it the server address and a read-only token in their shared
// App Group (renewed each time the app runs; it only opens /api/topshelf/, for 7 days).
// Selecting an item opens Panda at that title (pandatv://title/...), Play plays it.

import Foundation
import TVServices

private let appGroup = "group.app.panda.tv"

private struct Shelf: Decodable {
    let sections: [Section]

    struct Section: Decodable {
        let title: String
        /// "hdtv" (16:9 stills, Continue Watching) or "poster" (2:3).
        let shape: String
        let items: [Item]
    }

    struct Item: Decodable {
        let id: String
        let title: String
        /// Server path with its signature (`/api/images/...?t=`).
        let image: String?
        /// 0-1, for Continue Watching.
        let progress: Double?
        /// App path to open: `title/m123`, `series/Name`.
        let open: String
        /// App path that plays it: `play/title/m123?start=120`.
        let play: String?
    }
}

final class ContentProvider: TVTopShelfContentProvider {
    override func loadTopShelfContent(completionHandler: @escaping (TVTopShelfContent?) -> Void) {
        guard
            let shared = UserDefaults(suiteName: appGroup),
            let server = shared.string(forKey: "server"),
            let token = shared.string(forKey: "shelfToken"),
            var components = URLComponents(string: server + "/api/topshelf/items")
        else {
            completionHandler(nil)
            return
        }
        components.queryItems = [URLQueryItem(name: "t", value: token)]
        guard let url = components.url else {
            completionHandler(nil)
            return
        }
        let request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
        URLSession.shared.dataTask(with: request) { data, response, _ in
            guard
                let data,
                (response as? HTTPURLResponse)?.statusCode == 200,
                let shelf = try? JSONDecoder().decode(Shelf.self, from: data)
            else {
                // Nothing (offline server, expired token): tvOS shows the static Top Shelf image.
                completionHandler(nil)
                return
            }
            let sections = shelf.sections.compactMap { section -> TVTopShelfItemCollection<TVTopShelfSectionedItem>? in
                let items = section.items.map { entry in
                    Self.item(entry, shape: section.shape, server: server)
                }
                guard !items.isEmpty else { return nil }
                let collection = TVTopShelfItemCollection(items: items)
                collection.title = section.title
                return collection
            }
            completionHandler(sections.isEmpty ? nil : TVTopShelfSectionedContent(sections: sections))
        }.resume()
    }

    private static func item(_ entry: Shelf.Item, shape: String, server: String) -> TVTopShelfSectionedItem {
        let item = TVTopShelfSectionedItem(identifier: entry.id)
        item.title = entry.title
        item.imageShape = shape == "hdtv" ? .hdtv : .poster
        if let path = entry.image, let image = URL(string: server + path) {
            item.setImageURL(image, for: .screenScale1x)
            item.setImageURL(image, for: .screenScale2x)
        }
        if let progress = entry.progress {
            item.playbackProgress = min(max(progress, 0), 1)
        }
        if let open = URL(string: "pandatv://" + entry.open) {
            item.displayAction = TVTopShelfAction(url: open)
        }
        if let play = entry.play, let url = URL(string: "pandatv://" + play) {
            item.playAction = TVTopShelfAction(url: url)
        }
        return item
    }
}
