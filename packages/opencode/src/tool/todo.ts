import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION_READ from "./todoread.txt"
import DESCRIPTION_WRITE from "./todowrite.txt"
import { Todo } from "../session/todo"

// Todo.Info is still a zod schema (session/todo.ts). Inline the field shape
// here rather than referencing its `.shape` — the LLM-visible JSON Schema is
// identical, and it removes the last zod dependency from this tool.
const TodoItem = Schema.Struct({
  content: Schema.String.annotate({ description: "Brief description of the task" }),
  status: Schema.String.annotate({
    description: "Current status of the task: pending, in_progress, completed, cancelled",
  }),
  priority: Schema.String.annotate({ description: "Priority level of the task: high, medium, low" }),
})

export const Parameters = Schema.Struct({
  todos: Schema.mutable(Schema.Array(TodoItem)).annotate({ description: "The updated todo list" }),
})

export const ReadParameters = Schema.Struct({})

type Metadata = {
  todos: Todo.Info[]
}

function result(todos: Todo.Info[]) {
  return {
    title: `${todos.filter((item) => item.status !== "completed").length} todos`,
    output: JSON.stringify(todos, null, 2),
    metadata: {
      todos,
    },
  }
}

export const TodoWriteTool = Tool.define<typeof Parameters, Metadata, Todo.Service>(
  "todowrite",
  Effect.gen(function* () {
    const todo = yield* Todo.Service

    return {
      description: DESCRIPTION_WRITE,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "todowrite",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })

          yield* todo.update({
            sessionID: ctx.sessionID,
            todos: params.todos,
          })

          return result(params.todos)
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)

export const TodoReadTool = Tool.define<typeof ReadParameters, Metadata, Todo.Service>(
  "todoread",
  Effect.gen(function* () {
    const todo = yield* Todo.Service

    return {
      description: DESCRIPTION_READ,
      parameters: ReadParameters,
      execute: (_params: Schema.Schema.Type<typeof ReadParameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "todoread",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })

          return result(yield* todo.get(ctx.sessionID))
        }),
    } satisfies Tool.DefWithoutID<typeof ReadParameters, Metadata>
  }),
)
