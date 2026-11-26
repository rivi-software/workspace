import Foundation

extension WorkspaceClient {
  /// `GET /drive`: a folder by id, else a view (`mine` by default), or a search by name with `q`.
  public func drive(
    folder: String? = nil, view: DriveView? = nil, q: String? = nil, sort: DriveSort? = nil,
    direction: SortDirection? = nil
  ) async throws -> DriveListing {
    try await get(
      "/drive",
      query: [
        ("folder", folder), ("view", view?.rawValue), ("q", q), ("sort", sort?.rawValue),
        ("dir", direction?.rawValue),
      ])
  }

  /// `GET /drive/nodes/:id`.
  public func node(id: String) async throws -> NodeDetails {
    try await get("/drive/nodes/\(pathComponent(id))")
  }

  /// `GET /drive/files/:id`, the bytes to a temporary file; `asAttachment` adds `download=1`.
  public func downloadFile(id: String, asAttachment: Bool = false) async throws -> DownloadedFile {
    try await download(
      "/drive/files/\(pathComponent(id))", query: [("download", asAttachment ? "1" : nil)])
  }

  /// `PUT /drive/upload?folder&name` with the whole file as the body (at most 32 MB).
  public func upload(_ data: Data, folder: String, name: String, contentType: String) async throws -> DriveRow {
    let answer: NodeResult = try await put(
      "/drive/upload", query: [("folder", folder), ("name", name)], data: data,
      contentType: contentType)
    return answer.node
  }

  /// `POST /drive/upload` with `intent: "start"`, for a larger file in parts.
  public func startUpload(folder: String, name: String, size: Int64, type: String) async throws -> UploadStart {
    try await post(
      "/drive/upload",
      body: UploadIntent(intent: "start", folder: folder, name: name, size: size, type: type))
  }

  /// `PUT /drive/upload?id&part`, one part (`partSize` bytes, the last one smaller).
  public func uploadPart(id: String, part: Int, data: Data) async throws -> UploadedPart {
    let answer: UploadPartResult = try await put(
      "/drive/upload", query: [("id", id), ("part", String(part))], data: data,
      contentType: "application/octet-stream")
    return answer.part
  }

  /// `POST /drive/upload` with `intent: "finish"`.
  public func finishUpload(id: String, parts: [UploadedPart]) async throws -> DriveRow {
    let answer: NodeResult = try await post(
      "/drive/upload", body: UploadIntent(intent: "finish", id: id, parts: parts))
    return answer.node
  }

  /// `POST /drive/upload` with `intent: "abort"`.
  public func abortUpload(id: String) async throws -> OKResponse {
    try await post("/drive/upload", body: UploadIntent(intent: "abort", id: id))
  }

  /// `POST /drive/folders`; `parentId` nil for the root.
  public func createFolder(parentId: String?, name: String) async throws -> DriveRow {
    let answer: NodeResult = try await post(
      "/drive/folders", body: NewFolder(parentId: parentId, name: name))
    return answer.node
  }

  /// `POST /drive/nodes/:id/rename`.
  public func rename(id: String, name: String) async throws -> DriveRow {
    let answer: NodeResult = try await post(
      "/drive/nodes/\(pathComponent(id))/rename", body: RenameRequest(name: name))
    return answer.node
  }

  /// `POST /drive/nodes/star`.
  public func star(ids: [String], on: Bool) async throws -> Int {
    let answer: CountResponse = try await post("/drive/nodes/star", body: StarRequest(ids: ids, on: on))
    return answer.count
  }

  /// `POST /drive/nodes/trash`.
  public func trash(ids: [String]) async throws -> Int {
    let answer: CountResponse = try await post("/drive/nodes/trash", body: IdsRequest(ids: ids))
    return answer.count
  }

  /// `POST /drive/nodes/restore`.
  public func restore(ids: [String]) async throws -> Int {
    let answer: CountResponse = try await post("/drive/nodes/restore", body: IdsRequest(ids: ids))
    return answer.count
  }

  /// `POST /drive/nodes/delete`: for good, from the trash.
  public func deleteForever(ids: [String]) async throws -> Int {
    let answer: CountResponse = try await post("/drive/nodes/delete", body: IdsRequest(ids: ids))
    return answer.count
  }

  /// `POST /drive/nodes/move`; `targetId` nil for the root.
  public func move(ids: [String], targetId: String?) async throws -> Int {
    let answer: CountResponse = try await post(
      "/drive/nodes/move", body: MoveRequest(ids: ids, targetId: targetId))
    return answer.count
  }

  /// `POST /drive/trash/empty`.
  public func emptyDriveTrash() async throws -> Int {
    let answer: CountResponse = try await post("/drive/trash/empty")
    return answer.count
  }
}
