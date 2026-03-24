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
      _internal: {},
    };

    // Setup the mock handler instance behavior
    mockHandlerInstance = {
      isReadOperation: jest.fn(),
      isWriteOperation: jest.fn(),
      handleRead: jest.fn(),
      handleWrite: jest.fn(),
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
      expect.any(Function)
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
    // Custom implementation to check if 'this' is correct inside the callback
    mockHandlerInstance.handleRead.mockImplementation(
      (model: any, op: any, args: any, cb: any) => {
        return cb(args);
      }
    );

    const proxy = smartCache(mockPrisma, mockBento);
    await proxy.user.findMany({ id: 1 });

    // Ensure the original function was called with the model delegate as context
    expect(mockPrisma.user.findMany).toHaveBeenCalled();
    const context = mockPrisma.user.findMany.mock.instances[0];
    expect(context).toBe(mockPrisma.user);
  });
});
