import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';

type Todo = {
	id: string;
	text: string;
	completed: boolean;
};

function App() {
	const [todos, setTodos] = useState<Todo[]>([]);
	const [inputValue, setInputValue] = useState('');

	const addTodo = () => {
		if (inputValue.trim() === '') return;
		const newTodo: Todo = {
			id: Date.now().toString(),
			text: inputValue.trim(),
			completed: false,
		};
		setTodos([...todos, newTodo]);
		setInputValue('');
	};

	const toggleTodo = (id: string) => {
		setTodos(
			todos.map((t) => (t.id === id ? { ...t, completed: !t.completed } : t)),
		);
	};

	const deleteTodo = (id: string) => {
		setTodos(todos.filter((t) => t.id !== id));
	};

	return (
		<div className="todo-app">
			<header>
				<h1>📝 待办清单</h1>
			</header>
			<main>
				<div className="input-group">
					<input
						type="text"
						value={inputValue}
						onChange={(e) => setInputValue(e.target.value)}
						placeholder="输入新任务，回车添加..."
						onKeyDown={(e) => e.key === 'Enter' && addTodo()}
					/>
					<button onClick={addTodo}>+</button>
				</div>
				<ul className="todo-list">
					{todos.length === 0 ? (
						<li className="empty">暂无任务，添加一个吧！</li>
					) : (
						todos.map((todo) => (
							<li
								key={todo.id}
								className={`todo-item ${todo.completed ? 'completed' : ''}`}
							>
								<label>
									<input
										type="checkbox"
										checked={todo.completed}
										onChange={() => toggleTodo(todo.id)}
									/>
									<span className="text">{todo.text}</span>
								</label>
								<button
									className="delete-btn"
									onClick={() => deleteTodo(todo.id)}
								>
									×
								</button>
							</li>
						))
					)}
				</ul>
			</main>
		</div>
	);
}

const root = document.getElementById('root');
if (root) {
	createRoot(root).render(<App />);
}
