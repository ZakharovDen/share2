Отличный вопрос! Управление транзакциями, особенно в NestJS с Prisma, требует не просто вызова $transaction, а интеграции его в архитектуру проекта так, чтобы это было универсально и удобно.

Стандартный подход Prisma $transaction требует, чтобы вы передавали "клиента транзакции" (Prisma.TransactionClient) всем функциям, которые должны участвовать в этой транзакции. В NestJS это может стать громоздким, так как нарушает принцип DI (Dependency Injection), если каждый метод сервиса или репозитория должен принимать tx как аргумент.

Лучшим решением для NestJS является использование AsyncLocalStorage (ALS), что позволяет неявно передавать контекст транзакции по цепочке вызовов, не изменяя сигнатуры методов.

Вот пошаговая реализация универсального управления транзакциями с помощью AsyncLocalStorage, декораторов и NestJS Interceptor:

---

### Шаг 1: Создаем PrismaService

PrismaService будет расширять PrismaClient и управлять AsyncLocalStorage для контекста транзакции.

```ts
// src/prisma/prisma.service.ts
import { INestApplication, Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient, Prisma } from '@prisma/client';
import { AsyncLocalStorage } from 'async_hooks';

// Создаем глобальное хранилище для контекста транзакции
// Тип Prisma.TransactionClient представляет собой PrismaClient, но с ограниченным набором методов
// (только те, которые могут быть выполнены внутри транзакции).
export const prismaClientContext = new AsyncLocalStorage<Prisma.TransactionClient>();

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super(); // Вызываем конструктор базового класса PrismaClient
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  // Этот геттер будет использоваться в репозиториях для получения текущего клиента.
  // Если есть активная транзакция в текущем контексте ALS, он вернет клиента транзакции (tx).
  // В противном случае он вернет стандартный PrismaClient.
  get client(): PrismaClient | Prisma.TransactionClient {
    return prismaClientContext.getStore() || this;
  }

  // Метод для запуска новой транзакции.
  // Он обертывает Prisma.$transaction и управляет контекстом AsyncLocalStorage.
  async transaction<T>(callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.$transaction(async (tx) => {
      // Запускаем callback в контексте AsyncLocalStorage,
      // где Prisma.TransactionClient (tx) становится доступным через getStore().
      return prismaClientContext.run(tx, async () => {
        return callback(tx);
      });
    });
  }

  async enableShutdownHooks(app: INestApplication) {
    this.$on('beforeExit', async () => {
      await app.close();
    });
  }
}
```

### Шаг 2: Создаем декоратор @Transactional()

Этот декоратор будет помечать методы сервисов, которые должны выполняться в транзакции.

```ts
// src/common/decorators/transactional.decorator.ts
import { SetMetadata } from '@nestjs/common';

export const TRANSACTIONAL_KEY = 'transactional';

/**
 - Декоратор для пометки методов сервисов, которые должны выполняться в рамках одной транзакции базы данных.
 *
 - Пример использования:
 -
 - @Injectable()
 - class UserService {
 -   constructor(private readonly userRepository: UserRepository) {}
 *
 -   @Transactional()
 -   async createUserAndProfile(userData: any, profileData: any) {
 -     const user = await this.userRepository.createUser(userData);
 -     await this.userRepository.createProfile({ ...profileData, userId: user.id });
 -     return user;
 -   }
 - }
 *

 */
export const Transactional = () => SetMetadata(TRANSACTIONAL_KEY, true);

```

### Шаг 3: Создаем PrismaTransactionInterceptor

Этот перехватчик (Interceptor) будет читать метаданные @Transactional() и оборачивать выполнение помеченных методов в транзакцию Prisma.

```ts
// src/common/interceptors/prisma-transaction.interceptor.ts
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, throwError, from, lastValueFrom } from 'rxjs'; // Добавляем 'from' и 'lastValueFrom'
import { catchError } from 'rxjs/operators';
import { TRANSACTIONAL_KEY } from '../decorators/transactional.decorator'; // Корректный путь к декоратору
import { PrismaService } from '../../prisma/prisma.service'; // Корректный путь к PrismaService

@Injectable()
export class PrismaTransactionInterceptor implements NestInterceptor {
  private readonly logger = new Logger(PrismaTransactionInterceptor.name);

  constructor(
    private readonly prismaService: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const isTransactional = this.reflector.getAllAndOverride<boolean>(
      TRANSACTIONAL_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!isTransactional) {
      // Если метод не помечен @Transactional, просто продолжаем выполнение
      return next.handle();
    }

    this.logger.debug('Starting database transaction...');

    // Оборачиваем выполнение оригинального метода в транзакцию Prisma.
    // `prismaService.transaction` возвращает Promise, который мы оборачиваем в Observable с помощью `from`.
    return from(this.prismaService.transaction(async (tx) => {
      try {
        // `lastValueFrom` конвертирует Observable, возвращаемый `next.handle()`, в Promise.
        // Это эквивалентно поведению `toPromise()` в данном контексте.
        const result = await lastValueFrom(next.handle());
        this.logger.debug('Transaction committed successfully.');
        return result; // Возвращаем результат, который станет значением Promise и затем Observable.
      } catch (error) {
        // Если в методе произошла ошибка, Prisma автоматически выполнит ROLLBACK,
        // так как мы находимся внутри `$transaction` callback.
        this.logger.error(`Transaction rolled back due to error: ${error.message}`, error.stack);
        throw error; // Re-throw, чтобы ошибка была перехвачена внешним catchError или обработана Prisma.
      }
    })).pipe(
      // Обработка ошибок, которые могли произойти на уровне самой транзакции
      // (например, проблемы с соединением или ошибки, выброшенные из callback).
      catchError((error) => {
        this.logger.error(`Failed to execute transaction: ${error.message}`, error.stack);
        return throwError(() => error); // Пробрасываем ошибку дальше в цепочку NestJS.
      })
    );
  }
}
```

### Шаг 4: Регистрируем PrismaService и PrismaTransactionInterceptor

Для того чтобы PrismaService был доступен по всему приложению, а Interceptor применялся глобально.

```ts
// src/prisma/prisma.module.ts
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global() // Делаем PrismaService глобально доступным
@Module({
  providers: [PrismaService],
  exports: [PrismaService], // Экспортируем для использования в других модулях
})
export class PrismaModule {}
```

```ts
// src/app.module.ts
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module';
import { PrismaTransactionInterceptor } from './common/interceptors/prisma-transaction.interceptor';
import { UsersModule } from './users/users.module'; // Пример вашего модуля

@Module({
  imports: [
    PrismaModule,
    UsersModule, // Подключаем ваши модули
  ],
  controllers: [],
  providers: [
    {
      // Глобальная регистрация перехватчика для автоматического применения транзакций
      provide: APP_INTERCEPTOR,
      useClass: PrismaTransactionInterceptor,
    },
  ],
})
export class AppModule {}
```

### Шаг 5: Использование в сервисах и репозиториях

Теперь вы можете использовать PrismaService в своих репозиториях, а @Transactional() в сервисах.

Пример репозитория (src/users/users.repository.ts):

```ts
import { Injectable } from '@nestjs/common';
import { User, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UsersRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createUser(data: Prisma.UserCreateInput): Promise<User> {
    // Здесь 'this.prisma.client' автоматически вернет клиента транзакции,
    // если вызов был сделан из @Transactional метода, или обычный PrismaClient в противном случае.
    return this.prisma.client.user.create({ data });
  }

  async findUserById(id: number): Promise<User | null> {
    return this.prisma.client.user.findUnique({ where: { id } });
  }

  async updateUser(params: {
    where: Prisma.UserWhereUniqueInput;
    data: Prisma.UserUpdateInput;
  }): Promise<User> {
    const { where, data } = params;
    return this.prisma.client.user.update({ where, data });
  }

  async deleteUser(where: Prisma.UserWhereUniqueInput): Promise<User> {
    return this.prisma.client.user.delete({ where });
  }
}
```

Пример сервиса (src/users/users.service.ts):

```ts
import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { UsersRepository } from './users.repository';
import { Transactional } from '../common/decorators/transactional.decorator'; // Путь к декоратору

@Injectable()
export class UsersService {
  constructor(private readonly usersRepository: UsersRepository) {}

  // Этот метод будет выполняться в рамках одной транзакции.
  // Если createUserWithProfile, createUser или любая другая операция внутри этого метода
  // вызовет ошибку, все изменения будут автоматически отменены (ROLLBACK).
  @Transactional()
  async createUserAndProfile(userData: { name: string; email: string }, profileData: { bio: string }) {
    console.log('Service: Starting createUserAndProfile');
    const user = await this.usersRepository.createUser(userData);
    console.log(`Service: User created with ID: ${user.id}`);

    // Имитация другой операции, которая должна быть в той же транзакции
    // Например, создание профиля, связанного с пользователем
    // Предположим, у вас есть другой репозиторий для профилей или метод в UsersRepository
    // await this.profileRepository.createProfile({ ...profileData, userId: user.id });

    // Имитация ошибки для проверки отката транзакции
    if (userData.email === 'error@example.com') {
      console.error('Service: Simulating an error to trigger rollback.');
      throw new InternalServerErrorException('Simulated error during profile creation.');
    }

    // Еще одна операция в той же транзакции
    await this.usersRepository.updateUser({
      where: { id: user.id },
      data: { name: `${user.name} (Updated)` },
    });
    console.log(`Service: User ${user.id} updated within the same transaction.`);

    return user;
  }

  // Этот метод не будет использовать транзакцию, так как он не помечен @Transactional.
  async findUserById(id: number) {
    console.log('Service: Finding user by ID (non-transactional)');
    return this.usersRepository.findUserById(id);
  }
}
```

### Как это работает?

1. @Transactional() Декоратор: Помечает методы сервисов. На самом деле он просто добавляет метаданные к этим методам.
2. PrismaTransactionInterceptor:
  - APP_INTERCEPTOR глобально регистрирует этот перехватчик для всех запросов.
  - Когда запрос приходит, перехватчик проверяет метод, который собирается выполниться.
  - Reflector читает метаданные, установленные @Transactional().
  - Если метаданные указывают, что метод транзакционный, перехватчик вызывает this.prismaService.transaction().
3. PrismaService.transaction():
  -  Этот метод вызывает this.$transaction(async (tx) => { ... }) от Prisma. Это запускает интерактивную транзакцию Prisma.
  -  Ключевой момент: внутри callback-функции async (tx) => { ... } он использует prismaClientContext.run(tx, async () => { ... }). Это помещает tx (клиента транзакции) в AsyncLocalStorage для текущего асинхронного контекста.
4. PrismaService.client геттер:
  -  В любом репозитории, когда вы вызываете this.prisma.client.user.create(...), геттер client сначала проверяет prismaClientContext.getStore().
  -  Если AsyncLocalStorage содержит tx (потому что мы находимся внутри @Transactional метода), он возвращает tx.
  -  В противном случае (если метод не @Transactional), он возвращает обычный this (стандартный PrismaClient).
5. Rollback/Commit:
  -  Если next.handle().toPromise() (т.е., ваш @Transactional метод сервиса) завершается успешно, Prisma автоматически выполняет COMMIT.
  -  Если next.handle().toPromise() выбрасывает ошибку (или любая операция внутри tx выбрасывает ошибку), Prisma автоматически выполняет ROLLBACK.

### Преимущества этого решения:

-  Универсальность: Работает для любого метода сервиса, который вы пометите @Transactional().
-  Удобство: Вам не нужно вручную передавать tx по цепочке вызовов. Репозитории просто используют this.prisma.client, и он автоматически "знает", находится ли он в транзакции.
-  Чистый код: Бизнес-логика в сервисах и репозиториях остается чистой и не загромождена деталями управления транзакциями.
-  Идиоматичность NestJS: Использует стандартные паттерны NestJS (декораторы, перехватчики) и Node.js (AsyncLocalStorage).

Это надежное и масштабируемое решение для управления транзакциями в NestJS с Prisma.

## Диагностика

### 1. Прямая проверка this:

В геттере PrismaService.client, когда store отсутствует, сделайте следующую проверку:

```ts
    // src/prisma/prisma.service.ts
    // ...
    get client(): PrismaClient | Prisma.TransactionClient {
      const store = prismaClientContext.getStore();
      if (store) {
        console.log('PrismaService.client: Using transaction client');
        return store;
      }
      console.log('PrismaService.client: Using default Prisma client');
      
      // *** ГЛАВНАЯ ПРОВЕРКА ***
      if (this instanceof PrismaClient) {
          console.log('PrismaService.client: "this" IS an instance of PrismaClient.');
          // Проверим, есть ли у него свойство 'user' и является ли оно объектом/геттером
          if (this.user && typeof this.user === 'object') {
              console.log('PrismaService.client: "this.user" property exists and is an object.');
              // Проверим, есть ли у this.user метод findUnique
              if (typeof this.user.findUnique === 'function') {
                  console.log('PrismaService.client: "this.user.findUnique" is a function. All good!');
              } else {
                  console.error('PrismaService.client ERROR: "this.user.findUnique" is NOT a function, it is:', typeof this.user.findUnique, this.user);
              }
          } else {
              console.error('PrismaService.client ERROR: "this.user" property is missing or not an object:', this.user);
          }
      } else {
          console.error('PrismaService.client ERROR: "this" is NOT an instance of PrismaClient! Actual type:', this.constructor.name, this);
      }

      return this;
    }
```
### 2.  Замена return this; на явный PrismaClient (тест):

В качестве временного диагностического теста, попробуйте в геттере client создать новый экземпляр PrismaClient или получить его как-то иначе, если this не работает:

```ts
    // src/prisma/prisma.service.ts
    // ...
    // ВНИМАНИЕ: Это только для диагностики! Не оставлять в продакшене без тщательного обдумывания.
    // Если проблема в "this", этот подход может помочь обойти ее для не-транзакционных вызовов.
    let _fallbackPrismaClient: PrismaClient;

    get client(): PrismaClient | Prisma.TransactionClient {
      const store = prismaClientContext.getStore();
      if (store) {
        console.log('PrismaService.client: Using transaction client');
        return store;
      }
      console.log('PrismaService.client: Using default Prisma client');

      // Диагностический тест:
      // Если this не работает, попробуйте использовать отдельный экземпляр PrismaClient
      if (!this.user || typeof this.user.findUnique !== 'function') {
          console.error('PrismaService.client: "this" is not functioning as PrismaClient. Attempting fallback.');
          if (!_fallbackPrismaClient) {
              _fallbackPrismaClient = new PrismaClient();
              _fallbackPrismaClient.$connect().then(() => console.log('Fallback PrismaClient connected.')).catch(e => console.error('Fallback PrismaClient connection error:', e));
              // Добавим hook для $disconnect при завершении приложения для _fallbackPrismaClient
              // Но это может усложнить обработку жизненного цикла.
          }
          return _fallbackPrismaClient; // Возвращаем запасной клиент
      }

      return this;
    }
```

Если с этим _fallbackPrismaClient все работает, значит, проблема точно в том, что сам экземпляр PrismaService (this) теряет функциональность PrismaClient, когда он возвращается из геттера client. Это указывает на глубокую проблему с наследованием или инициализацией PrismaClient внутри PrismaService.

Скорее всего, проблема кроется в тонкостях наследования PrismaClient или в том, как NestJS инициализирует PrismaService в определенном контексте (не транзакционном). Детальная отладка с проверкой this должна прояснить ситуацию.