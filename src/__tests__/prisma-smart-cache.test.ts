import { PrismaSmartCache } from "../prisma-smart-cache";
import { RelationGraph } from "../utils/relation-graph";
import { buildCacheKey } from "../utils/key";
import { toKebab } from "../utils/casing";

jest.mock("../utils/relation-graph");
jest.mock("../utils/key");
jest.mock("../utils/casing");

describe("PrismaSmartCache", () => {
  let handler: PrismaSmartCache;
  let mockBento: any;
  let mockRelationGraph: jest.Mocked<RelationGraph>;
  const mockOriginalFn = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockBento = {
      get: jest.fn(),
      set: jest.fn(),
      delete: jest.fn(),
      deleteByTag: jest.fn(),
    };

    (toKebab as jest.Mock).mockImplementation((val) => val.toLowerCase());
    (buildCacheKey as jest.Mock).mockReturnValue("test-key");

    mockRelationGraph = new RelationGraph() as jest.Mocked<RelationGraph>;
    mockRelationGraph.getIncludedModels.mockReturnValue([]);
    mockRelationGraph.getRelatedModels.mockReturnValue([]);
    (RelationGraph as jest.Mock).mockReturnValue(mockRelationGraph);

    handler = new PrismaSmartCache(mockBento, { ttl: 60 });
  });

  test("handleRead returns cached data on hit", async () => {
    const data = { id: 1 };
    mockBento.get.mockResolvedValue(data);

    const result = await handler.handleRead(
      "User",
      "findUnique",
      {},
      mockOriginalFn
    );

    expect(result).toBe(data);
    expect(mockOriginalFn).not.toHaveBeenCalled();
  });

  test("handleRead fetches and sets cache on miss", async () => {
    const data = { id: 1 };
    mockBento.get.mockResolvedValue(null);
    mockOriginalFn.mockResolvedValue(data);

    const result = await handler.handleRead(
      "User",
      "findUnique",
      { where: { id: 1 } },
      mockOriginalFn
    );

    expect(result).toBe(data);
    expect(mockBento.set).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "test-key",
        value: data,
        ttl: 60000,
      })
    );
  });

  test("handleRead bypasses cache when disabled", async () => {
    mockOriginalFn.mockResolvedValue({ id: 1 });
    await handler.handleRead(
      "User",
      "findUnique",
      { cache: { disable: true } as any },
      mockOriginalFn
    );
    expect(mockBento.get).not.toHaveBeenCalled();
  });

  test("handleWrite triggers invalidation and returns result", async () => {
    const data = { id: 1 };
    mockOriginalFn.mockResolvedValue(data);

    const result = await handler.handleWrite(
      "User",
      "update",
      { data: { name: "new" } },
      mockOriginalFn
    );

    expect(result).toBe(data);
    expect(mockBento.deleteByTag).toHaveBeenCalledWith({ tags: ["user"] });
  });

  test("handleWrite can defer invalidation for transaction commits", async () => {
    const data = { id: 1 };
    const deferInvalidation = jest.fn();
    mockOriginalFn.mockResolvedValue(data);

    const result = await handler.handleWrite(
      "User",
      "update",
      { data: { name: "new" } },
      mockOriginalFn,
      { deferInvalidation }
    );

    expect(result).toBe(data);
    expect(deferInvalidation).toHaveBeenCalledWith({
      model: "User",
      operation: "update",
      args: { data: { name: "new" } },
    });
    expect(mockBento.deleteByTag).not.toHaveBeenCalled();
  });

  test("invalidate flushes deferred transaction invalidation", async () => {
    await handler.invalidate("User", "update", { data: { name: "new" } });

    expect(mockBento.deleteByTag).toHaveBeenCalledWith({ tags: ["user"] });
  });

  test("invalidate handles operations without data (delete)", async () => {
    mockOriginalFn.mockResolvedValue({});
    mockRelationGraph.getRelatedModels.mockReturnValue(["profile"]);

    await handler.handleWrite(
      "User",
      "delete",
      { where: { id: 1 } },
      mockOriginalFn
    );

    expect(mockBento.deleteByTag).toHaveBeenCalledWith({ tags: ["profile"] });
  });

  test("field-level invalidation checks overlaps", async () => {
    mockBento.get.mockResolvedValue(null);
    mockOriginalFn.mockResolvedValue({});

    const queryShape = { select: { email: true } };
    await handler.handleRead("User", "findUnique", queryShape, mockOriginalFn);

    mockBento.get.mockResolvedValueOnce({ __queryShape: queryShape });
    await handler.handleWrite(
      "User",
      "update",
      { data: { email: "new" } },
      mockOriginalFn
    );

    expect(mockBento.delete).toHaveBeenCalledWith({ key: "test-key" });
  });

  test("field-level invalidation skips when no overlap", async () => {
    mockBento.get.mockResolvedValue(null);
    mockOriginalFn.mockResolvedValue({});

    const queryShape = { select: { name: true } };
    await handler.handleRead("User", "findUnique", queryShape, mockOriginalFn);

    mockBento.get.mockResolvedValueOnce({ __queryShape: queryShape });
    await handler.handleWrite(
      "User",
      "update",
      { data: { age: 25 } },
      mockOriginalFn
    );

    expect(mockBento.delete).not.toHaveBeenCalledWith({ key: "test-key" });
  });

  test("operation type checks", () => {
    expect(handler.isReadOperation("findMany")).toBe(true);
    expect(handler.isReadOperation("create")).toBe(false);
    expect(handler.isWriteOperation("update")).toBe(true);
    expect(handler.isWriteOperation("findMany")).toBe(false);
  });

  test("invalidate deletes key and cleans index if entry is missing in cache", async () => {
    mockBento.get.mockResolvedValueOnce(null); // Miss during handleRead
    mockOriginalFn.mockResolvedValue({});
    await handler.handleRead("User", "findUnique", {}, mockOriginalFn);

    mockBento.get.mockResolvedValueOnce(null); // Entry expired/gone during invalidate
    await handler.handleWrite(
      "User",
      "update",
      { data: { name: "new" } },
      mockOriginalFn
    );

    expect(mockBento.delete).not.toHaveBeenCalled();
  });

  test("invalidate deletes key if __queryShape is missing", async () => {
    mockBento.get.mockResolvedValueOnce(null);
    mockOriginalFn.mockResolvedValue({});
    await handler.handleRead("User", "findUnique", {}, mockOriginalFn);

    mockBento.get.mockResolvedValueOnce({ data: "no-shape" }); // Missing __queryShape
    await handler.handleWrite(
      "User",
      "update",
      { data: { name: "new" } },
      mockOriginalFn
    );

    expect(mockBento.delete).toHaveBeenCalledWith({ key: "test-key" });
  });

  test("invalidate handles wildcard select (*)", async () => {
    mockBento.get.mockResolvedValueOnce(null);
    mockOriginalFn.mockResolvedValue({});
    await handler.handleRead("User", "findUnique", {}, mockOriginalFn); // No select = "*"

    mockBento.get.mockResolvedValueOnce({ __queryShape: {} });
    await handler.handleWrite(
      "User",
      "update",
      { data: { anyField: "val" } },
      mockOriginalFn
    );

    expect(mockBento.delete).toHaveBeenCalledWith({ key: "test-key" });
  });

  test("invalidate handles empty or non-object data gracefully", async () => {
    mockOriginalFn.mockResolvedValue({});
    await handler.handleWrite(
      "User",
      "update",
      { data: null as any },
      mockOriginalFn
    );
    expect(mockRelationGraph.getRelatedModels).toHaveBeenCalled();
  });
});
