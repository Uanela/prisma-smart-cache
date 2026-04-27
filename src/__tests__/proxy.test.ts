import { smartCache } from "../index"; // update with your actual path
import { PrismaSmartCache } from "../prisma-smart-cache";

jest.mock("../prisma-smart-cache");

describe("smartCache Proxy", () => {
  let mockBento: any;
  let mockPrisma: any;
  let mockHandlerInstance: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockBento = {};

    // Mocking the Prisma Client structure
    mockPrisma = {
      user: {
        findMany: jest.fn().mockResolvedValue([{ id: 1 }]),
        create: jest.fn().mockResolvedValue({ id: 2 }),
        otherMethod: jest.fn(),
      },
      $connect: jest.fn(),
      $transaction: jest.fn((arg: any, _options?: any) => {
        if (typeof arg === "function") {
          return Promise.resolve(arg(mockPrisma));
        }

        return Promise.resolve(arg);
      }),
      _internal: {},
    };

    // Setup the mock handler instance behavior
    mockHandlerInstance = {
      isReadOperation: jest.fn(),
      isWriteOperation: jest.fn(),
      handleRead: jest.fn(),
      handleWrite: jest.fn(),
      invalidate: jest.fn().mockResolvedValue(undefined),
    };

    (PrismaSmartCache as jest.Mock).mockImplementation(
      () => mockHandlerInstance
    );
  });

  test("should return internal prisma properties without proxying them", () => {
    const proxy = smartCache(mockPrisma, mockBento);

    expect(proxy.$connect).toBe(mockPrisma.$connect);
    expect(proxy._internal).toBe(mockPrisma._internal);
  });

  test("should intercept read operations and call handleRead", async () => {
    mockHandlerInstance.isReadOperation.mockReturnValue(true);
    mockHandlerInstance.handleRead.mockImplementation(
      (model: any, op: any, args: any, cb: any) => cb(args)
    );

    const proxy = smartCache(mockPrisma, mockBento);
    const args = { where: { id: 1 }, cache: { ttl: 100 } };

    await proxy.user.findMany(args);

    expect(mockHandlerInstance.handleRead).toHaveBeenCalledWith(
      "user",
      "findMany",
      args,
      expect.any(Function)
    );
    expect(mockPrisma.user.findMany).toHaveBeenCalledWith(args);
  });

  test("should intercept write operations and call handleWrite", async () => {
    mockHandlerInstance.isReadOperation.mockReturnValue(false);
    mockHandlerInstance.isWriteOperation.mockReturnValue(true);
    mockHandlerInstance.handleWrite.mockImplementation(
      (model: any, op: any, args: any, cb: any) => cb(args)
    );

    const proxy = smartCache(mockPrisma, mockBento);
    const args = { data: { name: "Test" } };

    await proxy.user.create(args);

    expect(mockHandlerInstance.handleWrite).toHaveBeenCalledWith(
      "user",
      "create",
      args,
      expect.any(Function),
      {}
    );
    expect(mockPrisma.user.create).toHaveBeenCalledWith(args);
  });

  test("should pass through methods that are neither read nor write operations", () => {
    mockHandlerInstance.isReadOperation.mockReturnValue(false);
    mockHandlerInstance.isWriteOperation.mockReturnValue(false);

    const proxy = smartCache(mockPrisma, mockBento);
    proxy.user.otherMethod("test-arg");

    expect(mockPrisma.user.otherMethod).toHaveBeenCalledWith("test-arg");
    expect(mockHandlerInstance.handleRead).not.toHaveBeenCalled();
    expect(mockHandlerInstance.handleWrite).not.toHaveBeenCalled();
  });

  test("should handle non-string or non-function properties on models gracefully", () => {
    mockPrisma.user.someValue = 123;
    const proxy = smartCache(mockPrisma, mockBento);

    expect(proxy.user.someValue).toBe(123);
  });

  test("should handle symbols or non-string property access", () => {
    const sym = Symbol("test");
    mockPrisma[sym] = "symbol-value";
    const proxy = smartCache(mockPrisma, mockBento);

    expect(proxy[sym as any]).toBe("symbol-value");
  });

  test("should maintain context (this) when calling original functions", async () => {
    mockHandlerInstance.isReadOperation.mockReturnValue(true);
    mockHandlerInstance.handleRead.mockImplementation(
      (model: any, op: any, args: any, cb: any) => {
        return cb(args);
      }
    );

    const proxy = smartCache(mockPrisma, mockBento);
    await proxy.user.findMany({ id: 1 });

    expect(mockPrisma.user.findMany).toHaveBeenCalled();
    const context = mockPrisma.user.findMany.mock.instances[0];
    expect(context).toBe(mockPrisma.user);
  });

  test("should wrap interactive transaction clients with cache by default", async () => {
    mockHandlerInstance.isReadOperation.mockImplementation(
      (op: string) => op === "findMany"
    );
    mockHandlerInstance.isWriteOperation.mockImplementation(
      (op: string) => op === "create"
    );
    mockHandlerInstance.handleRead.mockImplementation(
      (model: any, op: any, args: any, cb: any) => cb(args)
    );
    mockHandlerInstance.handleWrite.mockImplementation(
      (model: any, op: any, args: any, cb: any, options: any) => {
        options.deferInvalidation({ model, operation: op, args });
        return cb(args);
      }
    );

    const proxy = smartCache(mockPrisma, mockBento);

    await proxy.$transaction(async (tx: any) => {
      await tx.user.findMany({ where: { id: 1 } });
      await tx.user.create({ data: { name: "Test" } });
    });

    expect(mockHandlerInstance.handleRead).toHaveBeenCalledWith(
      "user",
      "findMany",
      { where: { id: 1 } },
      expect.any(Function)
    );
    expect(mockHandlerInstance.handleWrite).toHaveBeenCalledWith(
      "user",
      "create",
      { data: { name: "Test" } },
      expect.any(Function),
      expect.objectContaining({ deferInvalidation: expect.any(Function) })
    );
    expect(mockHandlerInstance.invalidate).toHaveBeenCalledWith(
      "user",
      "create",
      { data: { name: "Test" } }
    );
  });

  test("should pass raw transaction client when smartCache is disabled", async () => {
    mockHandlerInstance.isReadOperation.mockReturnValue(true);
    const proxy = smartCache(mockPrisma, mockBento);

    await proxy.$transaction(
      async (tx: any) => {
        await tx.user.findMany({ where: { id: 1 } });
      },
      { smartCache: { enabled: false }, timeout: 5000 }
    );

    expect(mockHandlerInstance.handleRead).not.toHaveBeenCalled();
    expect(mockPrisma.user.findMany).toHaveBeenCalledWith({ where: { id: 1 } });
    expect(mockPrisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { timeout: 5000 }
    );
  });

  test("should not invalidate transaction mutations when callback rejects", async () => {
    mockHandlerInstance.isReadOperation.mockReturnValue(false);
    mockHandlerInstance.isWriteOperation.mockImplementation(
      (op: string) => op === "create"
    );
    mockHandlerInstance.handleWrite.mockImplementation(
      (model: any, op: any, args: any, cb: any, options: any) => {
        options.deferInvalidation({ model, operation: op, args });
        return cb(args);
      }
    );
    mockPrisma.$transaction.mockImplementationOnce(async (arg: any) =>
      arg(mockPrisma)
    );

    const proxy = smartCache(mockPrisma, mockBento);

    await expect(
      proxy.$transaction(async (tx: any) => {
        await tx.user.create({ data: { name: "Test" } });
        throw new Error("rollback");
      })
    ).rejects.toThrow("rollback");

    expect(mockHandlerInstance.invalidate).not.toHaveBeenCalled();
  });

  test("should preserve array transactions", async () => {
    const prismaPromise = { then: jest.fn(), [Symbol.toStringTag]: "PrismaPromise" };
    const operations = [prismaPromise];
    const proxy = smartCache(mockPrisma, mockBento);

    await proxy.$transaction(operations as any);

    expect(mockPrisma.$transaction).toHaveBeenCalledWith(operations, undefined);
  });

  test("should expose raw client operations without smart cache interception", () => {
    mockHandlerInstance.isReadOperation.mockReturnValue(true);
    const prismaPromise = { then: jest.fn(), [Symbol.toStringTag]: "PrismaPromise" };
    mockPrisma.user.findMany.mockReturnValue(prismaPromise);

    const proxy = smartCache(mockPrisma, mockBento);
    const result = proxy.$raw.user.findMany({ cache: { ttl: 100 } } as any);

    expect(result).toBe(prismaPromise);
    expect(mockHandlerInstance.handleRead).not.toHaveBeenCalled();
    expect(mockPrisma.user.findMany).toHaveBeenCalledWith({});
  });
});
